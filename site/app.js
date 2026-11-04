// Tabs (auto-select Windows from the user agent) and copy buttons. No tracking.
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
  var status = document.querySelector('.status');

  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab, false); });
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next, true);
        e.preventDefault();
      }
    });
  });

  if (/Windows/i.test(navigator.userAgent)) select(document.getElementById('tab-win'), false);

  document.querySelectorAll('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.dataset.target).textContent;
      var done = function () { btn.textContent = 'Copied'; status.textContent = 'Command copied to clipboard.';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { status.textContent = 'Copy failed. Select the command and copy it manually.'; });
      } else {
        var r = document.createRange(); r.selectNodeContents(document.getElementById(btn.dataset.target));
        var s = getSelection(); s.removeAllRanges(); s.addRange(r);
        status.textContent = document.execCommand('copy') ? (done(), 'Command copied to clipboard.') : 'Press Ctrl+C / Cmd+C to copy.';
      }
    });
  });
})();
