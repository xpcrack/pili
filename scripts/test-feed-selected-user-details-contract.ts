import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function run() {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /import\s+\{\s*SelectedUserDetailsPanel\s*\}\s+from\s+'@\/components\/SelectedUserDetailsPanel'/,
    'page should import the extracted selected user details panel'
  );
  assert.match(
    source,
    /import\s+\{\s*useSelectedUserDetails\s*\}\s+from\s+'@\/hooks\/useSelectedUserDetails'/,
    'page should import the selected user details hook'
  );
  assert.match(
    source,
    /const\s*\{\s*details:\s*selectedUserDetails,\s*loading:\s*selectedUserDetailsLoading,\s*refreshing:\s*selectedUserDetailsRefreshing,\s*error:\s*selectedUserDetailsError,\s*retry:\s*retrySelectedUserDetails,\s*\}\s*=\s*useSelectedUserDetails\(selectedUserId\)/s,
    'page should wire the selected user details hook result to named variables'
  );
  assert.match(
    source,
    /<SelectedUserDetailsPanel[\s\S]*selectedUser=\{selectedUser\}[\s\S]*details=\{selectedUserDetails\}[\s\S]*detailsLoading=\{selectedUserDetailsLoading\}[\s\S]*detailsRefreshing=\{selectedUserDetailsRefreshing\}[\s\S]*detailsError=\{selectedUserDetailsError\}[\s\S]*onRetryDetails=\{retrySelectedUserDetails\}/,
    'page should pass the hook state and retry callback into the panel'
  );
  assert.doesNotMatch(
    source,
    /<ArrowLeft className="h-4 w-4" \/>[\s\S]*<Avatar className="h-10 w-10">[\s\S]*<div className="text-zinc-500">动态拆分<\/div>/,
    'page should remove the old inline selected-user summary block'
  );

  console.log('feed selected user details contract tests: ok');
}

void run();
