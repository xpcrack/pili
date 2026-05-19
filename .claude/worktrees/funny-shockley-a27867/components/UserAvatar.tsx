'use client';

import { User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUserStore } from '@/store/userStore';
import { getUserAvatar } from '@/lib/userProfile';

interface UserAvatarProps {
  user: User;
  isSelected?: boolean;
  onClick?: () => void;
}

export function UserAvatar({ user, isSelected, onClick }: UserAvatarProps) {
  const hasNew = useUserStore((state) => state.hasNew[user.id]);

  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 group relative min-w-[64px] ${
        isSelected ? 'opacity-100' : 'opacity-80'
      }`}
    >
      <div className="relative">
        <Avatar className={`h-12 w-12 transition-all duration-200 cursor-pointer ${
          isSelected 
            ? 'ring-2 ring-blue-500' 
            : 'ring-2 ring-transparent group-hover:ring-zinc-600'
        }`}>
          <AvatarImage src={getUserAvatar(user)} alt={user.name} />
          <AvatarFallback className="bg-zinc-800 text-zinc-400 text-xs">
            {user.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        
        {/* 红点标记 */}
        {hasNew && !isSelected && (
          <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500 ring-2 ring-zinc-950 animate-pulse" />
        )}
      </div>
      
      <span className={`text-xs truncate max-w-[60px] transition-colors ${
        isSelected ? 'text-blue-400 font-medium' : 'text-zinc-400 group-hover:text-zinc-200'
      }`}>
        {user.name}
      </span>
    </button>
  );
}
