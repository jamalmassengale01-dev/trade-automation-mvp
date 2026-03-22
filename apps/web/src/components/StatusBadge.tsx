'use client';

type StatusType = 
  | 'active' | 'inactive' | 'disabled'
  | 'pending' | 'processing' | 'completed' | 'failed' | 'rejected'
  | 'valid' | 'invalid' | 'duplicate'
  | 'filled' | 'canceled' | 'accepted';

interface StatusBadgeProps {
  status: StatusType | string;
  size?: 'sm' | 'md';
}

const statusStyles: Record<string, string> = {
  // Activity states
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-800',
  disabled: 'bg-red-100 text-red-800',
  
  // Process states
  pending: 'bg-yellow-100 text-yellow-800',
  processing: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  
  // Validation states
  valid: 'bg-green-100 text-green-800',
  invalid: 'bg-red-100 text-red-800',
  duplicate: 'bg-gray-100 text-gray-800',
  
  // Order states
  filled: 'bg-green-100 text-green-800',
  partially_filled: 'bg-blue-100 text-blue-800',
  canceled: 'bg-gray-100 text-gray-800',
  accepted: 'bg-blue-100 text-blue-800',
  submitted: 'bg-yellow-100 text-yellow-800',
  
  // Default
  default: 'bg-gray-100 text-gray-800',
};

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const style = statusStyles[status.toLowerCase()] || statusStyles.default;
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm';
  
  return (
    <span className={`inline-flex items-center rounded-full font-medium capitalize ${style} ${sizeClass}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
