/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

function extraArgs() {
  var accountType = document.getElementById("accountType").value;
  return {
    "accountType": {type: "char", value: accountType},
  };
}

function toggleDashboard() {
  var dashboard = document.getElementById("dashboard");
  var accountType = document.getElementById("accountType").value;
  if (accountType == "official")
    dashboard.setAttribute("href", "https://accounts.okeanos.grnet.gr/im/profile");
  else
    dashboard.setAttribute("href", "https://accounts.okeanos.io/im/profile");
}
