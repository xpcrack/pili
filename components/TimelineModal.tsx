'use client';

import { User, Activity, ActivitySource } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { 
  X, 
  Send, 
  Link2,
  ExternalLink,
  Copy,
  Clock
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useUserStore } from '@/store/userStore';
import { useEffect } from 'react';
import { getUserAvatar } from '@/lib/userProfile';
import { formatTokenAmount } from '@/lib/assetFormat';

interface TimelineModalProps {
  user: User | null;
  activities: Activity[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const sourceIcons: Record<ActivitySource, React.ReactNode> = {
  twitter: <X className="h-4 w-4" />,
  telegram: <Send className="h-4 w-4" />,
  blockchain: <Link2 className="h-4 w-4" />
};

const sourceColors: Record<ActivitySource, string> = {
  twitter: 'text-blue-400',
  telegram: 'text-sky-400',
  blockchain: 'text-emerald-400'
};

const sourceBgColors: Record<ActivitySource, string> = {
  twitter: 'bg-blue-500/10',
  telegram: 'bg-sky-500/10',
  blockchain: 'bg-emerald-500/10'
};

export function TimelineModal({ user, activities, open, onOpenChange }: TimelineModalProps) {
  const { selectUser, dismissNewForUser } = useUserStore();
  
  // 当弹窗打开时，清除该用户的红点
  useEffect(() => {
    if (open && user) {
      dismissNewForUser(user.id);
    }
  }, [open, user, dismissNewForUser]);

  // 关闭时清空选中
  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      selectUser(null);
    }
  };

  if (!user) return null;

  const sortedActivities = [...activities].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] bg-zinc-950 border-zinc-800 p-0 gap-0">
        {/* 头部：用户信息 */}
        <DialogHeader className="p-6 pb-4 border-b border-zinc-800/50">
          <div className="flex items-start gap-4">
            <Avatar className="h-16 w-16 ring-2 ring-zinc-800">
              <AvatarImage src={getUserAvatar(user)} alt={user.name} />
              <AvatarFallback className="bg-zinc-800 text-zinc-400">
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-xl font-semibold text-zinc-100 text-left">
                {user.name}
              </DialogTitle>
              <p className="text-zinc-500 text-sm mt-0.5">@{user.handle}</p>
              
              {/* 社交链接 & 地址 */}
              <div className="flex flex-wrap gap-2 mt-3">
                {user.twitter && (
                  <a 
                    href={`https://twitter.com/${user.twitter}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-blue-400 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                    @{user.twitter}
                  </a>
                )}
                {user.telegram && (
                  <a 
                    href={`https://t.me/${user.telegram}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-sky-400 transition-colors"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {user.telegram}
                  </a>
                )}
              </div>
              
              {/* 标签 */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {user.tags.map((tag) => (
                  <Badge 
                    key={tag}
                    variant="secondary"
                    className="text-[10px] px-2 py-0.5 bg-zinc-800/80 text-zinc-400 border-0"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* 时间线列表 */}
        <ScrollArea className="flex-1 h-[50vh]">
          <div className="p-6 space-y-0">
            {sortedActivities.map((activity, index) => (
              <TimelineItem 
                key={activity.id} 
                activity={activity} 
                isLast={index === sortedActivities.length - 1}
              />
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// 单条时间线项
function TimelineItem({ 
  activity, 
  isLast 
}: { 
  activity: Activity; 
  isLast: boolean;
}) {
  const timeStr = formatDistanceToNow(activity.timestamp, { 
    addSuffix: true,
    locale: zhCN 
  });
  const exactTime = format(activity.timestamp, 'yyyy-MM-dd HH:mm:ss', { locale: zhCN });
  const formattedTokenAmount = formatTokenAmount(activity.metadata.value);
  const contentText =
    activity.source === 'blockchain' && activity.type === 'transfer'
      ? activity.content.replace(
          /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/iu,
          formattedTokenAmount
        )
      : activity.content;

  const handleCopyHash = () => {
    if (activity.metadata.txHash) {
      navigator.clipboard.writeText(activity.metadata.txHash);
    }
  };

  const explorerUrl = (() => {
    if (!activity.metadata.txHash) {
      return null;
    }

    if (activity.metadata.chain === 'bsc') {
      return `https://web3.okx.com/explorer/bsc/tx/${activity.metadata.txHash}`;
    }

    if (activity.metadata.chain === 'solana') {
      return `https://web3.okx.com/explorer/solana/tx/${activity.metadata.txHash}`;
    }

    return null;
  })();

  return (
    <div className="relative flex gap-4 pb-6 group">
      {/* 时间线竖线 */}
      {!isLast && (
        <div className="absolute left-[19px] top-10 bottom-0 w-px bg-zinc-800" />
      )}
      
      {/* 来源图标 */}
      <div className={`relative z-10 flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${sourceBgColors[activity.source]} ${sourceColors[activity.source]}`}>
        {sourceIcons[activity.source]}
      </div>
      
      {/* 内容 */}
      <div className="flex-1 min-w-0">
        {/* 时间和来源 */}
        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
          <Clock className="h-3 w-3" />
          <span title={exactTime}>{timeStr}</span>
          <span className="text-zinc-600">•</span>
          <span className={sourceColors[activity.source]}>
            {activity.source === 'twitter' ? 'Twitter' : 
             activity.source === 'telegram' ? 'Telegram' : '链上'}
          </span>
        </div>
        
        {/* 标题 */}
        {activity.title && (
          <h4 className="text-zinc-200 font-medium text-sm mb-1">
            {activity.title}
          </h4>
        )}
        
        {/* 正文 */}
        <p className="text-zinc-400 text-sm leading-relaxed mb-2">
          {contentText}
        </p>
        
        {/* 元数据 */}
        {activity.source === 'blockchain' && (
          <div className="flex items-center gap-3 text-xs flex-wrap">
            {activity.metadata.value && (
              <span className="text-emerald-400 font-medium">
                {formattedTokenAmount}
              </span>
            )}
            {activity.metadata.chain && (
              <span className="text-zinc-500 bg-zinc-800/50 px-2 py-0.5 rounded">
                {activity.metadata.chain}
              </span>
            )}
            {activity.metadata.txHash && (
              <div className="flex items-center gap-1 group/hash">
                {explorerUrl ? (
                  <a 
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-0.5"
                  >
                    {activity.metadata.txHash.slice(0, 8)}...{activity.metadata.txHash.slice(-6)}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-zinc-600">
                    {activity.metadata.txHash.slice(0, 8)}...{activity.metadata.txHash.slice(-6)}
                  </span>
                )}
                <button 
                  onClick={handleCopyHash}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors p-0.5"
                  title="复制交易哈希"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            )}
            {activity.metadata.uncertainFrom && (
              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-300">
                来源待确认（可能为代付/聚合器）
              </span>
            )}
          </div>
        )}
        
        {/* 社交互动数据 */}
        {(activity.source === 'twitter' || activity.source === 'telegram') && activity.metadata.likes !== undefined && (
          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
            {activity.metadata.likes > 0 && (
              <span>{activity.metadata.likes.toLocaleString()} 赞</span>
            )}
            {activity.metadata.replies !== undefined && activity.metadata.replies > 0 && (
              <span>{activity.metadata.replies} 回复</span>
            )}
            {activity.metadata.views && (
              <span>{activity.metadata.views} 浏览</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
