import React from 'react';

export interface PesoSignProps {
  size?: number | string;
  className?: string;
}

export const PesoSign: React.FC<PesoSignProps> = ({ size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`inline-block shrink-0 ${className}`}
  >
    {/* Base P loop and vertical stem */}
    <path d="M7 21V4h6.5a5 5 0 0 1 5 5c0 2.76-2.24 5-5 5H7" />
    {/* Upper horizontal strike */}
    <path d="M4 8.5h12" />
    {/* Lower horizontal strike */}
    <path d="M4 11.5h12" />
  </svg>
);
