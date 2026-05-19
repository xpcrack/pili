import { Activity, User } from '@/types';

// 不再生成假数据
// 返回空数组，等待真实 API 对接

export function generateMockActivities(users: User[]): { user: User; activities: Activity[] }[] {
  return users.map(user => ({
    user,
    activities: []
  }));
}

export function getFeedActivities(): { user: User; activity: Activity }[] {
  return [];
}
