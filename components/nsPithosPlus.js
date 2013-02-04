/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the PithosPlus implementation of the
 * nsIMsgCloudFileProvider interface.
 */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/gloda/log4moz.js");
Cu.import("resource:///modules/cloudFileAccounts.js");

var gPithosUrl = "https://pithos.okeanos.grnet.gr/v1/";
var gPublicUrl = "https://pithos.okeanos.grnet.gr";

const kContainer = "ThunderBird FileLink/";
const kUpdate = "?update&format=json"


function nsPithosPlus() {
  this.log = Log4Moz.getConfiguredLogger("PithosPlus");
}

nsPithosPlus.prototype = {
  /* nsISupports */
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),

  classID: Components.ID("{026722d4-5e2b-11e2-ab23-b6f96188709b}"),

  get type() "PithosPlus",
  get displayName() "Pithos+",
  get serviceURL() "https://okeanos.io/",
  get iconClass() "chrome://pithosplus/content/pithosplus.png",
  get accountKey() this._accountKey,
  get lastError() this._lastErrorText,
  get settingsURL() "chrome://pithosplus/content/settings.xhtml",
  get managementURL() "chrome://pithosplus/content/management.xhtml",

  _accountKey: false,
  _prefBranch: null,
  _userName: "",
  _loggedIn: false,
  _userInfo: false,
  _file : null,
  _requestDate: null,
  _successCallback: null,
  _connection: null,
  _request: null,
  _maxFileSize : -1,
  _fileSpaceUsed : -1,
  _availableStorage : -1,
  _totalStorage: -1,
  _lastErrorStatus : 0,
  _lastErrorText : "",
  _uploadingFile : null,
  _uploader : null,
  _urlsForFiles : {},
  _uploadInfo : {}, // upload info keyed on aFiles.
  _uploads: [],

  /**
   * Initializes an instance of this nsIMsgCloudFileProvider for an account
   * with key aAccountKey.
   *
   * @param aAccountKey the account key to initialize with.
   */
  init: function nsPithosPlus_init(aAccountKey) {
    this.log.info("in init");
    this._accountKey = aAccountKey;
    this._prefBranch = Services.prefs.getBranch(
            "mail.cloud_files.accounts." +  aAccountKey + ".");
    this._userName = this._prefBranch.getCharPref("username");
    this._loggedIn = this._cachedAuthToken != "";
  },


  /**
   * Private callback function passed to, and called from
   * nsPithosPlusFileUploader.
   *
   * @param aRequestObserver a request observer for monitoring the start and
   *                         stop states of a request.
   * @param aStatus the status of the request.
   */
  _uploaderCallback: function nsPithosPlus__uploaderCallback(
                         aRequestObserver, aStatus) {
    aRequestObserver.onStopRequest(null, null, aStatus);

    this._uploadingFile = null;
    this._uploads.shift();
    if (this._uploads.length > 0) {
      let nextUpload = this._uploads[0];
      this.log.info("chaining upload, file = " + nextUpload.file.leafName);
      this._uploadingFile = nextUpload.file;
      this._uploader = nextUpload;
      try {
        this.uploadFile(nextUpload.file, nextUpload.requestObserver);
      }
      catch (ex) {
        // I'd like to pass ex.result, but that doesn't seem to be defined.
        nextUpload.callback(nextUpload.requestObserver, Cr.NS_ERROR_FAILURE);
      }
    }
    else
      this._uploader = null;
  },


  /**
   * Attempts to upload a file to PithosPlus servers.
   *
   * @param aFile the nsILocalFile to be uploaded
   * @param aCallback an nsIRequestObserver for monitoring the start and
   *                  stop states of the upload procedure.
   */
  uploadFile: function nsPithosPlus_uploadFile(aFile, aCallback) {
    this.log.info("in upload file");
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    this.log.info("Preparing to upload a file");

    // if we're uploading a file, queue this request.
    if (this._uploadingFile && this._uploadingFile != aFile) {
      this.log.info("Adding file to queue");
      let uploader = new nsPithosPlusFileUploader(
          this, aFile, this._uploaderCallback.bind(this), aCallback);
      this._uploads.push(uploader);
      return;
    }

    this._uploadingFile = aFile;
    this._urlListener = aCallback;

    let finish = function() {
      this._finishUpload(aFile, aCallback);
    }.bind(this);

    let onAuthFailure = function() {
      this._urlListener.onStopRequest(
          null, null, Ci.nsIMsgCloudFileProvider.authErr);
    }.bind(this);

    this.log.info("Checking to see if we're logged in");

    if (!this._loggedIn) {
      let onLoginSuccess = function() {
        this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);
      }.bind(this);
      return this.logon(onLoginSuccess, onAuthFailure, true);
    }

    if (!this._userInfo)
      return this._getUserInfo(finish, onAuthFailure);

    finish();
  },

  /**
   * A private function called when we're almost ready to kick off the upload
   * for a file. First, ensures that the file size is not too large, and that
   * we won't exceed our storage quota, and then kicks off the upload.
   *
   * @param aFile the nsILocalFile to upload
   * @param aCallback the nsIRequestObserver for monitoring the start and stop
   *                  states of the upload procedure.
   */
  _finishUpload: function nsPihosPlus__finishUpload(aFile, aCallback) {
    let cancel = Ci.nsIMsgCloudFileProvider.uploadCanceled;

    if (this._maxFileSize != -1 && aFile.fileSize > this._maxFileSize)
      return aCallback.onStopRequest(null, null, cancel);
    if (aFile.fileSize > this._availableStorage)
      return aCallback.onStopRequest(null, null, cancel);

    this._userInfo = false; // force us to update userInfo on every upload.

    if (!this._uploader) {
      this._uploader = new nsPithosPlusFileUploader(
          this, aFile, this._uploaderCallback.bind(this), aCallback);
      this._uploads.unshift(this._uploader);
    }

    this._uploadingFile = aFile;
    this._uploader.startUpload();
  },

  /**
   * Attempts to cancel a file upload.
   *
   * @param aFile the nsILocalFile to cancel the upload for.
   */
  cancelFileUpload: function nsPithosPlus_cancelFileUpload(aFile) {
    this.log.info("in cancel upload");
    if (this._uploadingFile != null && this._uploader != null &&
        this._uploadingFile.equals(aFile)) {
      this._uploader.cancel();
    }
    else {
      for (let i = 0; i < this._uploads.length; i++)
        if (this._uploads[i].file.equals(aFile)) {
          this._uploads[i].requestObserver.onStopRequest(
            null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
          this._uploads.splice(i, 1);
          return;
        }
    }
  },


  /**
   * Returns the sharing URL for some uploaded file.
   *
   * @param aFile the nsILocalFile to get the URL for.
   */
  urlForFile: function nsYouSendIt_urlForFile(aFile) {
    return this._urlsForFiles[aFile.path];
  },


  /**
   * A private function for retrieving profile information about a user.
   *
   * @param successCallback a callback fired if retrieving profile information
   *                        is successful.
   * @param failureCallback a callback fired if retrieving profile information
   *                        fails.
   */
  _getUserInfo: function nsPithosPlus_userInfo(successCallback, failureCallback) {
    this.log.info("getting user info");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("HEAD", gPithosUrl + this._userName, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this.log.info("request status = " + req.status);
        this._userInfo = true;
        this._fileSpaceUsed =
          parseInt(req.getResponseHeader("X-Account-Bytes-Used"));
        this._availableStorage =
          parseInt(req.getResponseHeader("X-Account-Policy-Quota")) -
          this._fileSpaceUsed;
        this.log.info("available storage = " + this._availableStorage);
        successCallback();
      } else {
        this.log.info("Our token has gone stale - requesting a new one.");
        let retryGetUserInfo = function() {
          this._getUserInfo(successCallback, failureCallback);
        }.bind(this);
        this.clearPassword();
        this._loggedIn = false;
        this.logon(retryGetUserInfo, failureCallback, true);
        return;
      }
    }.bind(this);

    req.onerror = function() {
      this.log.info("getUserInfo failed - status = " + req.status);
      failureCallback();
    }.bind(this);

    req.setRequestHeader("X-Auth-Token", this._cachedAuthToken);
    req.setRequestHeader("Content-type", "application/xml");
    req.send();
  },


  /**
   * Attempts to refresh cached profile information for the account associated
   * with this instance's account key.
   *
   * @param aWithUI a boolean for whether or not we should prompt the user for
   *                a new token if we don't have a proper one.
   * @param aListener an nsIRequestObserver for monitoring the start and stop
   *                  states of fetching profile information.
   */
  refreshUserInfo: function nsPithosPlus_refreshUserInfo(aWithUI, aListener) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    aListener.onStartRequest(null, null);
    // Let's define some reusable callback functions...
    let onGetUserInfoSuccess = function() {
      aListener.onStopRequest(null, null, Cr.NS_OK);
    }
    let onAuthFailure = function() {
      aListener.onStopRequest(null, null,
          Ci.nsIMsgCloudFileProvider.authErr);
    }

    // If we're not logged in, attempt to login, and then attempt to
    // get user info if logging in is successful.
    this.log.info("Checking to see if we're logged in");
    if (!this._loggedIn) {
      let onLoginSuccess = function() {
        this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);
      }.bind(this);
      return this.logon(onLoginSuccess, onAuthFailure, aWithUI);
    }

    // If we're logged in, attempt to get user info.
    if (!this._userInfo)
      return this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);
  },


  /**
   * For a particular error, return a URL if Pithos has a page for handling
   * that particular error.
   *
   * @param aError an error to get the URL for.
   */
  providerUrlForError: function nsPithosPlus_providerUrlForError(aError) {
    return "";
  },


  /**
   * If the provider doesn't have an API for creating an account, perhaps
   * there's a url we can load in a content tab that will allow the user
   * to create an account.
   */
  get createNewAccountUrl() "https://okeanos.grnet.gr",

  get fileUploadSizeLimit() this._maxFileSize,
  get remainingFileSpace() this._availableStorage,
  get fileSpaceUsed() this._fileSpaceUsed,


  /**
   * Our PithosPlus implementation does not implement the
   * createNewAccount function defined in nsIMsgCloudFileProvider.idl.
   */
  createNewAccount: function nsPithosPlus_createNewAccount(
          aEmailAddress, aPassword, aFirstName, aLastName) {
    return Cr.NS_ERROR_NOT_IMPLEMENTED;
  },


  /**
   * If a the user associated with this account key already has an account,
   * allows them to log in.
   *
   * @param aRequestObserver an nsIRequestObserver for monitoring the start and
   *                         stop states of the login procedure.
   */
  createExistingAccount: function nsPithosPlus_createExistingAccount(
                             aRequestObserver) {
     // XXX: replace this with a better function
    let successCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(null, this, Cr.NS_OK);
    }.bind(this);

    let failureCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(
              null, this, Ci.nsIMsgCloudFileProvider.authErr);
    }.bind(this);

    this.logon(successCb, failureCb, true);
  },


  /**
   * Attempt to delete an upload file if we've uploaded it.
   *
   * @param aFile the file that was originall uploaded
   * @param aCallback an nsIRequestObserver for monitoring the starting and
   *                  ending states of the deletion request.
   */
  deleteFile: function nsPithosPlus_deleteFile(aFile, aCallback) {
    this.log.info("Deleting a file");

    if (Services.io.offline) {
      this.log.error("We're offline - we can't delete the file.");
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    let uploadPath = this._uploadInfo[aFile.path];
    if (!uploadPath) {
      this.log.error("Could not find a record for the file to be deleted.");
      throw Cr.NS_ERROR_FAILURE;
    }

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("DELETE", uploadPath, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    req.onerror = function() {
      let response = JSON.parse(req.responseText);
      this._lastErrorStatus = response.errorStatus.status;
      this._lastErrorText = response.errorStatus.message;
      this.log.error("There was a problem deleting: " + this._lastErrorText);
      aCallback.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this.log.info("Delete was successful!");
        aCallback.onStopRequest(null, null, Cr.NS_OK);
      } else {
        this.log.error("Server has returned a failure on our delete request.");
        this.log.error("Error code: " + req.status);
        this.log.error("Error message: " + req.responseText);
        //aCallback.onStopRequest(null, null,
        //                        Ci.nsIMsgCloudFileProvider.uploadErr);
        aCallback.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
        return;
      }
    }.bind(this);

    req.setRequestHeader("Content-type", "application/json");
    req.setRequestHeader("X-Auth-Token", this._cachedAuthToken);
    req.send();
  },


  /**
   * This function is used by our testing framework to override the default
   * URL's that nsPithosPlus connects to.
   */
  overrideUrls : function nsPithosPlus_overrideUrls(aNumUrls, aUrls) {
    gPithosUrl = aUrls[0];
  },


  /**
   * Returns the saved password for this account if one exists, or prompts
   * the user for a password. Returns the empty string on failure.
   *
   * @param aUsername the username associated with the account / password.
   * @param aNoPrompt a boolean for whether or not we should suppress
   *                  the password prompt if no password exists.  If so,
   *                  returns the empty string if no password exists.
   */
  getPassword: function nsPithosPlus_getPassword(aUsername, aNoPrompt) {
    this.log.info("Getting password for user: " + aUsername);

    if (aNoPrompt)
      this.log.info("Suppressing password prompt");

    if (this._cachedAuthToken != "")
      return this._cachedAuthToken;

    if (aNoPrompt)
      return "";

    // OK, let's prompt for it.
    let win = Services.wm.getMostRecentWindow(null);

    let authPrompter = Services.ww.getNewAuthPrompter(win);
    let password = { value: "" };
    // Prompt for a token
    let messengerBundle = Services.strings.createBundle(
        "chrome://pithosplus/locale/messenger.properties");
    let promptString = messengerBundle.formatStringFromName(
        "ppTokenPrompt", [this._userName, this.displayName], 2);

    if (authPrompter.prompt(this.displayName, promptString, gPithosUrl,
                authPrompter.SAVE_PASSWORD_NEVER, null, password))
      return password.value;

    return "";
  },


  /**
   * Clears any saved PithosPlus passwords for this instance's account.
   */
  clearPassword: function nsPithosPlus_clearPassword() {
    this._cachedAuthToken = "";
  },


  /**
   * logon to the pithos account.
   *
   * @param successCallback - called if logon is successful
   * @param failureCallback - called back on error.
   * @param aWithUI if false, logon fails if it would have needed to put up UI.
   *                This is used for things like displaying account settings,
   *                where we don't want to pop up the oauth ui.
   */
  logon: function nsPithosPlus_login(successCallback, failureCallback, aWithUI) {
    this.log.info("Logging in, aWithUI = " + aWithUI);
    this._cachedAuthToken = this.getPassword(this._userName, !aWithUI);
    this.log.info("Sending login information...");

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("GET", gPithosUrl + this._userName, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    req.onerror = function() {
      this.log.info("logon failure");
      this.clearPassword();
      failureCallback();
    }.bind(this);

    req.onload = function() {
      if(req.status == 200) {
        this._loggedIn = true;
        successCallback();
      } else {
        this.clearPassword();
        this._loggedIn = false;
        this._lastErrorText = req.responseText;
        this._lastErrorStatus = req.status;
        failureCallback();
      }
    }.bind(this);

    req.setRequestHeader("Content-type", "application/json");
    req.setRequestHeader("X-Auth-Token", this._cachedAuthToken);
    req.send();
    this.log.info("Login information sent!");
  },


  /**
   * Retrieves the cached auth token for this account.
   */
  get _cachedAuthToken() {
    let authToken = cloudFileAccounts.getSecretValue(
            this.accountKey, cloudFileAccounts.kTokenRealm);
    if(!authToken)
      return "";
    return authToken;
  },


  /**
   * Sets the cached auth token for this account.
   *
   * @param aAuthToken the auth token to cache.
   */
  set _cachedAuthToken(aAuthToken) {
    cloudFileAccounts.setSecretValue(
            this.accountKey, cloudFileAccounts.kTokenRealm, aAuthToken);
  },
};


function nsPithosPlusFileUploader(aPithosPlus, aFile, aCallback, aRequestObserver) {
  this.pithosplus = aPithosPlus;
  this.log = this.pithosplus.log;
  this.log.info("new nsPithosPlusFileUploader file = " + aFile.leafName);
  this.file = aFile;
  this.callback = aCallback;
  this.requestObserver = aRequestObserver;
}

nsPithosPlusFileUploader.prototype = {
  pithosplus : null,
  file : null,
  callback : null,
  _request : null,


  /**
   * Kicks off the upload procedure for this uploader.
   */
  startUpload: function nsPFU_startUpload() {
    this.requestObserver.onStartRequest(null, null);

    let onSuccess = function() {
      this._uploadFile();
    }.bind(this);

    let onFailure = function() {
      this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    return this._prepareToSend(onSuccess, onFailure);
  },


  /**
   * Compute the URL that we will use to send the upload.
   *
   * @param successCallback the callback fired on success
   * @param failureCallback the callback fired on failure
   */
  _prepareToSend: function nsPFU__prepareToSend(successCallback,
                                                failureCallback) {
    // First create the container
    let container = gPithosUrl + this.pithosplus._userName + "/" + kContainer;
    let dateStr = this._formatDate();
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("PUT", container, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        let fileName = /^[\040-\176]+$/.test(this.file.leafName)
          ? this.file.leafName
          : encodeURIComponent(this.file.leafName);
        this._urlFile = container + dateStr + "/" + fileName;
        this.pithosplus._uploadInfo[this.file.path] = this._urlFile;
        successCallback();
      } else {
        this.log.error("Preparing to send failed!");
        this.log.error("Response was: " + req.responseText);
        this.pithosplus._lastErrorText = req.responseText;
        this.pithosplus._lastErrorStatus = req.status;
        failureCallback();
      }
    }.bind(this);

    req.onerror = function () {
        failureCallback();
    }.bind(this);

    req.setRequestHeader("X-Auth-Token", this.pithosplus._cachedAuthToken);
    req.setRequestHeader("Content-Type", "application/json");
    req.send();
  },


  /**
   * Format current date
   */
  _formatDate: function nsPFU__formatDate() {
    let m_names = new Array("Jan", "Feb", "Mar", "Apr", "May",
        "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec");
    let date = new Date();
    var curr_hour = date.getHours() + "";
    if (curr_hour.length == 1)
      curr_hour = "0" + curr_hour;
    var curr_min = date.getMinutes() + "";
    if (curr_min.length == 1)
      curr_min = "0" + curr_min;
    var curr_sec = date.getSeconds() + "";
    if (curr_sec.length == 1)
      curr_sec = "0" + curr_sec;
    let dateStr = date.getDate() + " " + m_names[date.getMonth()] +
      " " + date.getFullYear() + "  " + curr_hour + ":" +
      curr_min + ":" + curr_sec;

    return dateStr;
  },


  /**
   * Once we've got the URL to upload the file to, this function actually
   * does the upload of the file to Pithos+.
   */
  _uploadFile: function nsPFU__uploadFile() {
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    this.log.info("upload url = " + this._urlFile);
    this.request = req;
    req.open("PUT", this._urlFile, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    req.onload = function() {
      this.cleanupTempFile();
      if (req.status >= 200 && req.status < 400) {
        this._publish();
      } else {
        this.callback(this.requestObserver,
            Ci.nsIMsgCloudFileProvider.uploadErr);
      }
    }.bind(this);

    req.onerror = function () {
      this.cleanupTempFile();
      if (this.callback)
        this.callback(this.requestObserver,
            Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    let contentType;
    try {
        contentType = mimeService.getTypeFromFile(this.file);
    }
    catch (ex) {
        contentType = "application/octet-stream";
    }
    req.setRequestHeader("X-Auth-Token", this.pithosplus._cachedAuthToken);
    req.setRequestHeader("Content-type", contentType);
    try {
      this._fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                     .createInstance(Ci.nsIFileInputStream);
      this._fstream.init(this.file, -1, 0, 0);
      this._bufStream = Cc["@mozilla.org/network/buffered-input-stream;1"]
                        .createInstance(Ci.nsIBufferedInputStream);
      this._bufStream.init(this._fstream, 4096);
      req.send(this._bufStream.QueryInterface(Ci.nsIInputStream));
    } catch (ex) {
      this.cleanupTempFile();
      this.log.error(ex);
      throw ex;
    }
  },


  /**
   * Cancels the upload request for the file associated with this Uploader.
   */
  cancel: function nsPFU_cancel() {
    this.log.info("in uploader cancel");
    this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadCanceled);
    delete this.callback;
    if (this.request) {
      this.log.info("cancelling upload request");
      let req = this.request;
      if (req.channel) {
        this.log.info("cancelling upload channel");
        req.channel.cancel(Cr.NS_BINDING_ABORTED);
      }
      this.request = null;
    }
  },


  /**
   * Publish the file
   */
  _publish: function nsPFU__publish() {
    this.log.info("Making file " + this.file + " public");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("POST", this._urlFile + kUpdate, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    let failed = function() {
      this.callback(this.requestObserver,
          Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this._getShareUrl();
      } else {
        failed();
      }
    }.bind(this);

    req.onerror = function() {
      failed();
    }.bind(this);

    req.setRequestHeader("X-Auth-Token", this.pithosplus._cachedAuthToken);
    req.setRequestHeader("X-Object-Public", "True");
    req.setRequestHeader("Content-type", "application/json");
    req.send();
  },

  /**
   * Attempt to retrieve the sharing URL for the file uploaded.
   */
  _getShareUrl: function nsPFU__getShareUrl() {
    this.log.info("Get public url for " + this.file);
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("HEAD", this._urlFile, true);
    req.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;

    let succeed = function() {
      this.callback(this.requestObserver, Cr.NS_OK);
    }.bind(this);

    let failed = function() {
      if (this.callback)
        this.callback(this.requestObserver,
            Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this.pithosplus._urlsForFiles[this.file.path] =
          gPublicUrl + req.getResponseHeader("x-object-public");
        succeed();
      } else {
        failed();
      }
    }.bind(this);

    req.setRequestHeader("X-Auth-Token", this.pithosplus._cachedAuthToken);
    req.setRequestHeader("Content-type", "application/json");
    req.send();
  },


  /**
   * Cleans up any temporary files that this
   * nsPithosPlusFileUploader may have created.
   */
  cleanupTempFile: function nsPFU_cleanupTempFile() {
    if (this._bufStream)
      this._bufStream.close();
    if (this._fstream)
      this._fstream.close();
  },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsPithosPlus]);
