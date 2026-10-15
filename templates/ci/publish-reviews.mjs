import { publishReviewAuthorizations } from '../../lib/review-publish.js';
if (!process.argv[2]) throw new Error('必须指定中央固定Review签发配置文件');
const result = await publishReviewAuthorizations({ configFile: process.argv[2] });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.errors.length ? 2 : 0;
