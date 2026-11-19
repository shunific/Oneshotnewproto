import logo from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';

export function LoadingRing({ className = 'h-12 w-12' }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={`relative grid shrink-0 place-items-center ${className}`}>
      <span aria-hidden="true" className="absolute inset-0 rounded-full border-[3px] border-emerald-500/25" />
      <span aria-hidden="true" className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-emerald-500 border-r-emerald-500 motion-safe:animate-spin" />
      <img src={logo} alt="" className="h-2/3 w-2/3 rounded-full object-contain" />
    </div>
  );
}
