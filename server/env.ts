import fs from 'node:fs';
import path from 'node:path';

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!key) {
    return null;
  }

  let value = trimmed.slice(separatorIndex + 1).trim();
  const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");

  if (doubleQuoted || singleQuoted) {
    value = value.slice(1, -1);
  } else {
    // 未加引号：剥离行内注释（# 前需有空白），不做转义处理
    const inlineComment = value.indexOf(' #');
    if (inlineComment >= 0) {
      value = value.slice(0, inlineComment).trimEnd();
    }
    value = value.trim();
  }

  if (doubleQuoted) {
    // 双引号内按 dotenv 语义反转义：\n→换行、\t→制表、\\→反斜杠、\"→引号
    value = value.replace(/\\([\\'"nt])/g, (_, ch: string) =>
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch
    );
  }
  // 单引号与裸值：保持字面，不做任何反转义

  return {
    key,
    value,
  };
}

export function loadRuntimeEnv(repoRoot: string) {
  const envCandidates = [
    path.join(repoRoot, '.env.local'),
    path.join(path.resolve(repoRoot, '..', '..'), '.env.local'),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) {
        continue;
      }

      if (process.env[parsed.key] === undefined) {
        process.env[parsed.key] = parsed.value;
      }
    }

    return {
      loaded: true,
      envPath,
    };
  }

  return {
    loaded: false,
    envPath: envCandidates[0],
  };
}
