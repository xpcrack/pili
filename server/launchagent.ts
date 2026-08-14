import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.xp.pilipili.local-live';

function launchctlGuiTarget() {
  if (typeof process.getuid !== 'function') {
    throw new Error('process.getuid is unavailable in this runtime');
  }

  return `gui/${process.getuid()}`;
}

function plistPath() {
  return path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
}

function buildPlist(repoRoot: string) {
  const bunPath = path.join(os.homedir(), '.bun/bin/bun');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>local:live</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>3005</string>
    <key>NODE_USE_ENV_PROXY</key>
    <string>1</string>
    <key>HTTP_PROXY</key>
    <string>http://127.0.0.1:7897</string>
    <key>HTTPS_PROXY</key>
    <string>http://127.0.0.1:7897</string>
    <key>ALL_PROXY</key>
    <string>http://127.0.0.1:7897</string>
    <key>NO_PROXY</key>
    <string>127.0.0.1,localhost,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(repoRoot, '.data', 'launchagent.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(repoRoot, '.data', 'launchagent.err.log')}</string>
</dict>
</plist>
`;
}

function install(repoRoot: string) {
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.data'), { recursive: true });
  fs.writeFileSync(target, buildPlist(repoRoot), 'utf8');
  try {
    execFileSync('launchctl', ['bootout', `${launchctlGuiTarget()}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // Ignore missing/previously unloaded jobs during install.
  }
  // bootout 已杀掉旧 live 进程；必须重新 bootstrap + kickstart，
  // 否则升级后 live 服务一直停摆到重启。
  try {
    execFileSync('launchctl', ['bootstrap', launchctlGuiTarget(), target], { stdio: 'ignore' });
  } catch {
    // already bootstrapped (first install after bootout race) — ignore
  }
  execFileSync('launchctl', ['enable', `${launchctlGuiTarget()}/${LABEL}`], { stdio: 'ignore' });
  execFileSync('launchctl', ['kickstart', '-k', `${launchctlGuiTarget()}/${LABEL}`], { stdio: 'ignore' });
}

function restart() {
  const guiTarget = launchctlGuiTarget();
  execFileSync('launchctl', ['bootstrap', guiTarget, plistPath()], { stdio: 'inherit' });
  execFileSync('launchctl', ['enable', `${guiTarget}/${LABEL}`], { stdio: 'inherit' });
  execFileSync('launchctl', ['kickstart', '-k', `${guiTarget}/${LABEL}`], { stdio: 'inherit' });
}

function main() {
  const command = process.argv[2];
  if (command === 'install') {
    install(process.cwd());
    console.log(`installed ${plistPath()}`);
    return;
  }
  if (command === 'restart') {
    restart();
    return;
  }

  console.error('Usage: bun server/launchagent.ts <install|restart>');
  process.exit(1);
}

main();
