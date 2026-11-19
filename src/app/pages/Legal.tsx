import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { ChevronLeft, Shield, FileText } from 'lucide-react';

export function Legal() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reservationTerms, rates, siteConfig } = useAppContext();
  const venueName = siteConfig?.venueName || siteConfig?.venuename || siteConfig?.venue_name || siteConfig?.name || 'One Shot Bar & Billiards';
  const contactEmail = siteConfig?.contactEmail || siteConfig?.contactemail || siteConfig?.contact_email || siteConfig?.email;
  const contactNumber = siteConfig?.contactNumber || siteConfig?.contactnumber || siteConfig?.contact_number || siteConfig?.phone;
  const cancellationPolicy = reservationTerms.cancellationPolicy?.trim();
  const generalTerms = reservationTerms.termsAndConditions?.trim();
  const [activeTab, setActiveTab] = useState<'terms' | 'privacy'>('terms');

  useEffect(() => {
    window.scrollTo(0, 0);
    if (searchParams.get('tab') === 'privacy') {
      setActiveTab('privacy');
    } else {
      setActiveTab('terms');
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-300 font-sans selection:bg-emerald-500/30">
      
      {/* Header */}
      <header className="sticky top-0 z-50 bg-neutral-950/80 backdrop-blur-md border-b border-neutral-800 px-6 py-4 flex items-center">
        <button 
          onClick={() => navigate(-1)} 
          className="flex items-center gap-2 text-sm font-bold text-neutral-400 hover:text-white transition-colors"
        >
          <ChevronLeft size={18} /> Back
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-black text-white mb-8 tracking-tight">Legal Information</h1>

        {/* Tabs */}
        <div className="flex gap-2 bg-neutral-900 p-1.5 rounded-xl border border-neutral-800 mb-10 w-fit">
          <button 
            onClick={() => setActiveTab('terms')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'terms' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            <FileText size={16} /> Terms of Service
          </button>
          <button 
            onClick={() => setActiveTab('privacy')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${activeTab === 'privacy' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            <Shield size={16} /> Privacy Policy
          </button>
        </div>

        {/* Content */}
        <div className="prose prose-invert prose-emerald max-w-none">
          {activeTab === 'terms' ? (
            <div className="space-y-6 text-sm leading-relaxed">
              
              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">1. Acceptance of Terms</h2>
              <p>By accessing and using the {venueName} reservation system, you agree to be bound by these Terms of Service. If you do not agree to these terms, please refrain from using our online booking platform.</p>

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">2. Reservations and Down Payments</h2>
              <ul className="list-disc pl-5 space-y-2 text-neutral-400">
                <li>The booking form shows the table rate and down payment{Number(rates.downPaymentPercent) > 0 ? ` (${rates.downPaymentPercent}% of the table fee)` : ''}. Eligible Trusted Customers receive a waiver for bookings of up to three hours.</li>
                <li>Down payments are processed via GCash. Uploaded receipts are verified by staff.</li>
                <li>The remaining balance of the table rate and any associated Food & Beverage orders must be settled at the venue.</li>
              </ul>

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">3. Cancellations, Refunds & Rescheduling</h2>
              <p>Sign in to the account used to book to request a cancellation or reschedule. Staff review each request.</p>
              {Number(reservationTerms.cancellationHours) > 0 && <p>Cancellation notice: {reservationTerms.cancellationHours} hours before the scheduled booking.</p>}
              {cancellationPolicy && <p className="whitespace-pre-line">{cancellationPolicy}</p>}

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">4. User Accounts</h2>
              <p>Users are responsible for maintaining the confidentiality of their account credentials. {venueName} reserves the right to terminate accounts that violate our community guidelines or exploit the reservation system.</p>
              {generalTerms && <>
                <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">5. General Terms & Conditions</h2>
                <p className="whitespace-pre-line">{generalTerms}</p>
              </>}
            </div>
          ) : (
            <div className="space-y-6 text-sm leading-relaxed">

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">1. Information We Collect</h2>
              <p>To provide a seamless booking experience, we collect the following information:</p>
              <ul className="list-disc pl-5 space-y-2 text-neutral-400">
                <li><strong>Personal Data:</strong> Name, Email Address, and Phone Number provided during registration or booking.</li>
                <li><strong>OAuth Data:</strong> If logging in via Google or Facebook, we receive your public profile information (Name, Email, Profile Picture) authorized by the provider.</li>
                <li><strong>Usage Data:</strong> Reservation history, trusted customer metrics, and general platform interaction logs.</li>
              </ul>

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">2. How We Use Your Data</h2>
              <p>Your data is strictly used for operational purposes:</p>
              <ul className="list-disc pl-5 space-y-2 text-neutral-400">
                <li>To confirm and manage your table reservations.</li>
                <li>To calculate your Net Trust Score and assign loyalty benefits.</li>
                <li>To process down payment verifications and refunds.</li>
                <li>To send operational notifications regarding your booking status.</li>
              </ul>

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">3. Data Security & Storage</h2>
              <p>Your data is securely stored using industry-standard encryption via Supabase. We do not sell, rent, or share your personal data with third-party advertisers. Supabase Auth manages customer passwords. Staff cannot view them in the POS.</p>

              <h2 className="text-xl font-bold text-white mt-8 mb-4 border-b border-neutral-800 pb-2">4. Account Deletion</h2>
              <p>Choose “Delete Account” in your account settings to mark your account for deletion. The system replaces the name and phone number in your profile and retains historical transaction records.</p>
            </div>
          )}
          {(contactEmail || contactNumber) && (
            <p className="mt-8 border-t border-neutral-800 pt-4 text-sm">
              Questions about these policies? Contact {venueName} at {contactEmail && <a href={`mailto:${contactEmail}`}>{contactEmail}</a>}{contactEmail && contactNumber && ' or '}{contactNumber}.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}