'use client';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ 
  page, 
  pageSize, 
  total, 
  totalPages, 
  onPageChange 
}: PaginationProps) {
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between mt-4">
      <div className="text-sm text-gray-500">
        Showing {startItem} to {endItem} of {total} results
      </div>
      
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
