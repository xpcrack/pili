import { listAddressManagementRows } from '@/lib/server/addressManagementRepo';
import { apiError, apiOk } from '@/lib/server/apiResponse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return apiOk({ rows: listAddressManagementRows() });
  } catch (error) {
    return apiError(error, { fallback: '读取地址列表失败' });
  }
}
