const DOKOBOT_ARTIFACT_PATTERN =
  /^(?:\/(?:analytics|home|explore|notifications|messages|bookmarks|jobs|grok|communities|premium|verified-orgs)\b|(?:帖子|回复|亮点|文章|媒体|正在关注|关注者|社群|发现更多|发布你的回复|相关))$/iu;

export function normalizeTwitterArtifactCandidate(value: string) {
  return value.replace(/\[\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isLikelyTwitterArtifactText(value: string) {
  const normalized = normalizeTwitterArtifactCandidate(value);
  if (!normalized) {
    return true;
  }
  return DOKOBOT_ARTIFACT_PATTERN.test(normalized);
}
