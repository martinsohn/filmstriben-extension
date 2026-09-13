(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const status = $('status');

  const say = (msg, kind) => {
    status.textContent = msg;
    status.className = kind || '';
  };

  chrome.storage.local.get(['apiKey', 'username', 'password']).then((cfg) => {
    $('apiKey').value = cfg.apiKey || '';
    $('username').value = cfg.username || '';
    $('password').value = cfg.password || '';
  });

  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
      apiKey: $('apiKey').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
      token: null,      // force a fresh login with the new credentials
    });
    say('Gemt.', 'ok');
  });

  $('test').addEventListener('click', async () => {
    say('Tester…');
    try {
      await chrome.storage.local.set({
        apiKey: $('apiKey').value.trim(),
        username: $('username').value.trim(),
        password: $('password').value,
        token: null,
      });
      const res = await chrome.runtime.sendMessage({ type: 'os.login' });
      if (!res || res.ok === false) throw new Error((res && res.error) || 'ukendt fejl');
      say(res.data.loggedIn ? 'Login lykkedes.' : 'Nøgle gemt (intet login — anonym kvote).', 'ok');
    } catch (err) {
      say(`Fejl: ${err.message}`, 'warn');
    }
  });
})();
