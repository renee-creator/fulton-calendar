// A local trial server with stand-ins for GitHub and Google, for trying the page without touching real records.
// Run with  node test/dev.js  then open http://127.0.0.1:4000/app/  and sign in with  willow creek 9  (director) or  maple garden 42
const { spawn } = require('child_process');
const path = require('path');
const { fakeGitHub, fakeFeed } = require('./fakes.js');
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
(async () => {
  const ghPort = await listen(fakeGitHub), feedPort = await listen(fakeFeed);
  const port = process.env.PORT || 4000;
  console.log('Example Google calendar address to paste in Settings  http://127.0.0.1:' + feedPort + '/feeds/good.ics');
  spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: 'inherit', env: { ...process.env, PORT: port, GITHUB_API: 'http://127.0.0.1:' + ghPort, RECORDS_REPO: 'o/r', GITHUB_TOKEN: 'trial',
    TEACHER_PASSCODES: 'Renee=willow creek 9,Hannah=maple garden 42,Chris=river stone 7', FLUSH_DELAY_MS: '200', FEED_TEST_BASE: 'http://127.0.0.1:' + feedPort } });
})();
