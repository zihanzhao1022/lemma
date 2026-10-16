import React from 'react';
import { Account } from './accounts';

// Muted tones that keep white initials readable.
const TONES = ['#6d28d9', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#4d7c0f'];

/** The account's GitHub picture, or its initials in a circle (the made-up accounts have no picture). */
const Avatar: React.FC<{ account: Account; size?: number; className?: string }> = ({ account, size = 24, className = '' }) => {
  if (account.avatarUrl) {
    return <img src={account.avatarUrl} alt="" width={size} height={size} className={`inline-block shrink-0 rounded-full bg-gray-100 ${className}`} style={{ width: size, height: size }} />;
  }
  const tone = TONES[[...account.login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TONES.length];
  const initials = (account.name || account.login)
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42, background: tone }}
    >
      {initials}
    </span>
  );
};

export default Avatar;
