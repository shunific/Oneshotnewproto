import logo from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';

export function LoadingRing({ className = 'h-12 w-12' }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={`relative grid shrink-0 place-items-center ${className}`}>
      <span aria-hidden="true" className="absolute inset-0 rounded-full border-[3px] border-emerald-500/25" />
      <span aria-hidden="true" className="absolute inset-0 animate-spin rounded-full motion-reduce:[animation-duration:4s]">
        <span className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-emerald-500" />
        <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/4 rounded-full bg-emerald-500" />
      </span>
      <img src={logo} alt="" className="h-2/3 w-2/3 rounded-full object-contain" />
    </div>
  );
}
