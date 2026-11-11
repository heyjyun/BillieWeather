// Applies the saved theme before first paint (loaded without defer in <head>).
// The choice ("light" | "dark"; absent = follow the system) and the sidebar state live only in this
// browser's localStorage. Nothing here is sent to the server.
(function () {
  "use strict";
  try {
    var theme = window.localStorage.getItem("billie.theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
    if (window.localStorage.getItem("billie.sidebar") === "collapsed") document.documentElement.setAttribute("data-sidebar", "collapsed");
  } catch (error) { /* storage unavailable: follow the system theme */ }
})();
