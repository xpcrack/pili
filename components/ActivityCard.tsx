'use client';

import { Activity, User, ActivitySource } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getUserAvatar } from '@/lib/userProfile';
import { 
  X, 
  Send, 
  Link2, 
  ArrowRightLeft, 
  Image as ImageIcon,
  MessageCircle,
  Eye,
  ThumbsUp
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

interface ActivityCardProps {
  activity: Activity;
  user: User;
  onClick?: () => void;
}

const sourceIcons: Record<ActivitySource, React.ReactNode> = {
  twitter: <X className="h-3.5 w-3.5" />,
  telegram: <Send className="h-3.5 w-3.5" />,
  blockchain: <Link2 className="h-3.5 w-3.5" />
};

const sourceLabels: Record<ActivitySource, string> = {
  twitter: 'Twitter',
  telegram: 'Telegram',
  blockchain: '链上'
};

const typeLabels: Record<string, string> = {
  post: '发布',
  transfer: '转账',
  swap: '兑换',
  nft_trade: 'NFT交易',
  mint: '铸造'
};

export function ActivityCard({ activity, user, onClick }: ActivityCardProps) {
  const timeAgo = formatDistanceToNow(activity.timestamp, { 
    addSuffix: true,
    locale: zhCN 
  });

  const isBlockchain = activity.source === 'blockchain';
  const hasMedia = activity.metadata.media && activity.metadata.media.length > 0;

  return (
    <Card 
      className="bg-zinc-900/50 border-zinc-800/50 hover:bg-zinc-900/80 transition-colors cursor-pointer group"
      onClick={onClick}
    >
      <CardContent className="p-4">
        {/* 头部：头像、用户名、时间 */}
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10">
            <AvatarImage src={getUserAvatar(user)} alt={user.name} />
            <AvatarFallback className="bg-zinc-800 text-zinc-400 text-xs">
              {user.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-zinc-100 text-sm">
                {user.name}
              </span>
              <span className="text-zinc-500 text-xs">
                {timeAgo}
              </span>
            </div>
            
            {/* 来源标签 */}
            <div className="flex items-center gap-1.5 mt-0.5">
              <Badge 
                variant="secondary" 
                className="text-[10px] px-1.5 py-0 h-4 bg-zinc-800/80 text-zinc-400 border-0"
              >
                <span className="flex items-center gap-1">
                  {sourceIcons[activity.source]}
                  {sourceLabels[activity.source]}
                </span>
              </Badge>
              <Badge 
                variant="outline" 
                className="text-[10px] px-1.5 py-0 h-4 border-zinc-700/50 text-zinc-500"
              >
                {typeLabels[activity.type] || activity.type}
              </Badge>
            </div>
          </div>
        </div>

        {/* 内容区 */}
        <div className="mt-3 flex gap-3">
          {/* 缩略图区域 */}
          {(hasMedia || isBlockchain) && (
            <div className="shrink-0">
              <div className="relative w-28 h-16 rounded-lg bg-zinc-800/50 overflow-hidden flex items-center justify-center border border-zinc-700/30">
                {isBlockchain ? (
                  <div className="flex flex-col items-center text-zinc-500">
                    <ArrowRightLeft className="h-5 w-5 mb-0.5" />
                    <span className="text-[10px]">交易</span>
                  </div>
                ) : hasMedia ? (
                  <div className="flex flex-col items-center text-zinc-500">
                    <ImageIcon className="h-5 w-5 mb-0.5" />
                    <span className="text-[10px]">媒体</span>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* 文字内容 */}
          <div className="flex-1 min-w-0">
            {activity.title && (
              <h3 className="text-zinc-100 text-sm font-medium mb-1 line-clamp-1 group-hover:text-blue-400 transition-colors">
                {activity.title}
              </h3>
            )}
            <p className="text-zinc-400 text-sm line-clamp-2">
              {activity.content}
            </p>
            
            {/* 链上交易详情 */}
            {isBlockchain && activity.metadata.value && (
              <p className="text-zinc-500 text-xs mt-1">
                金额: <span className="text-emerald-400">{activity.metadata.value}</span>
                {activity.metadata.chain && (
                  <span className="ml-2 text-zinc-600">• {activity.metadata.chain}</span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* 底部：互动数据 */}
        <div className="flex items-center gap-4 mt-3 text-zinc-500 text-xs">
          {activity.metadata.likes !== undefined && (
            <span className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
              <ThumbsUp className="h-3.5 w-3.5" />
              {activity.metadata.likes}
            </span>
          )}
          {activity.metadata.replies !== undefined && (
            <span className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
              <MessageCircle className="h-3.5 w-3.5" />
              {activity.metadata.replies}
            </span>
          )}
          {activity.metadata.views && (
            <span className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
              <Eye className="h-3.5 w-3.5" />
              {activity.metadata.views}
            </span>
          )}
          
          {isBlockchain && activity.metadata.txHash && (
            <span className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              {activity.metadata.txHash.slice(0, 8)}...{activity.metadata.txHash.slice(-6)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
