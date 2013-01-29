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

// The kMaxFileSize may be a fixed limit.
const kMaxFileSize = 157286400;

const kDeletePath = "fileops/delete/?root=sandbox";
const kSharesPath = "shares/sandbox/";
const kFilesPutPath = "files_put/sandbox/";


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
  _authToken: "",
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


  /** XXX
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
    throw Ci.nsIMsgCloudFileProvider.offlineErr;
  },


  /** XXX
   * Attempts to cancel a file upload.
   *
   * @param aFile the nsILocalFile to cancel the upload for.
   */
  cancelFileUpload: function nsPithosPlus_cancelFileUpload(aFile) {
    this.log.info("in cancel upload");
    return Cr.NS_ERROR_NOT_IMPLEMENTED;
  },


  /** XXX
   * Returns the sharing URL for some uploaded file.
   *
   * @param aFile the nsILocalFile to get the URL for.
   */
  urlForFile: function nsYouSendIt_urlForFile(aFile) {
    return this._urlsForFiles[aFile.path];
  },


  /** XXX
   * Attempts to refresh cached profile information for the account associated
   * with this instance's account key.
   *
   * @param aWithUI a boolean for whether or not we should prompt the user for
   *                a new token if we don't have a proper one.
   * @param aListener an nsIRequestObserver for monitoring the start and stop
   *                  states of fetching profile information.
   */
  refreshUserInfo: function nsYouSendIt_refreshUserInfo(aWithUI, aListener) {
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


  /** XXX
   * Attempt to delete an upload file if we've uploaded it.
   *
   * @param aFile the file that was originall uploaded
   * @param aCallback an nsIRequestObserver for monitoring the starting and
   *                  ending states of the deletion request.
   */
  deleteFile: function nsPithosPlus_deleteFile(aFile, aCallback) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    throw Ci.nsIMsgCloudFileProvider.offlineErr;
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
    let passwordURI = gPithosUrl;
    let logins = Services.logins.findLogins({}, passwordURI, null, passwordURI);
    for each (let loginInfo in logins) {
      if (loginInfo.username == aUsername)
        return loginInfo.password;
    }
    if (aNoPrompt)
      return "";

    // OK, let's prompt for it.
    let win = Services.wm.getMostRecentWindow(null);

    let authPrompter = Services.ww.getNewAuthPrompter(win);
    let password = { value: "" };
    // Use the service name in the prompt text
    let serverUrl = gPithosUrl;
    let messengerBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messenger.properties");
    let promptString = messengerBundle.formatStringFromName(
            "passwordPrompt", [this._userName, this.displayName], 2);

    if (authPrompter.promptPassword(this.displayName, promptString, serverUrl,
                authPrompter.SAVE_PASSWORD_PERMANENTLY, password))
      return password.value;

    return "";
  },

  /**
   * Clears any saved PithosPlus passwords for this instance's account.
   */
  clearPassword: function nsPithosPlus_clearPassword() {
    let logins = Services.logins.findLogins({}, gPithosUrl, null, gPithosUrl);
    for each (let loginInfo in logins)
      if (loginInfo.username == this._userName)
        Services.logins.removeLogin(loginInfo);
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
    if(this._authToken == undefined || !this._authToken)
      this._authToken = this.getPassword(this._userName, !aWithUI);
    this.log.info("Sending login information...");

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("GET", gPithosUrl + this._userName, true);

    req.onerror = function() {
      this.log.info("logon failure");
      failureCallback();
    }.bind(this);

    req.onload = function() {
      if(req.status == 200) {
        this._cachedAuthToken = this._authToken;
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
    req.setRequestHeader("X-Auth-Token", this._authToken);
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


  /** XXX
   * Kicks off the upload procedure for this uploader.
   */
  startUpload: function nsPFU_startUpload() {
    let curDate = Date.now().toString();
    return;
  },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsPithosPlus]);
