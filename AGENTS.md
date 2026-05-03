<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:runtime-rules -->
# Runtime

Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.
<!-- END:runtime-rules -->
