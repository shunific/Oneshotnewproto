-- One Shot Bar & Billiards Management System - Supabase Schema
-- Tattoo-related tables and schemas have been completely removed.

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. ENUMS
CREATE TYPE table_status AS ENUM ('available', 'occupied', 'reserved');
CREATE TYPE queue_status AS ENUM ('waiting', 'called', 'seated');
CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'checked-in', 'completed', 'cancelled');
CREATE TYPE feedback_type AS ENUM ('suggestion', 'complaint', 'lost_item', 'compliment', 'other');
CREATE TYPE staff_role AS ENUM ('manager', 'cashier');
CREATE TYPE announcement_type AS ENUM ('info', 'warning', 'promo', 'event');

-- 3. TABLES

-- Tables
CREATE TABLE public.tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    status table_status NOT NULL DEFAULT 'available',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions (Active or Past Billiards Sessions)
CREATE TABLE public.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID REFERENCES public.tables(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    duration_minutes INTEGER NOT NULL,
    is_paid BOOLEAN NOT NULL DEFAULT false,
    hourly_rate DECIMAL(10, 2) NOT NULL,
    amount_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Queue
CREATE TABLE public.queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    party_size INTEGER NOT NULL,
    arrival_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    notes TEXT,
    status queue_status NOT NULL DEFAULT 'waiting',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reservations
CREATE TABLE public.reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    email TEXT,
    reservation_date DATE NOT NULL,
    time_slot TIME NOT NULL,
    duration_hours INTEGER NOT NULL,
    party_size INTEGER NOT NULL,
    table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,
    status reservation_status NOT NULL DEFAULT 'pending',
    total_amount DECIMAL(10, 2) NOT NULL,
    down_payment_amount DECIMAL(10, 2) NOT NULL,
    down_payment_paid BOOLEAN NOT NULL DEFAULT false,
    balance_paid BOOLEAN NOT NULL DEFAULT false,
    cancellation_reason TEXT,
    promo_code TEXT,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Feedback
CREATE TABLE public.feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_name TEXT NOT NULL,
    contact_info TEXT,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    feedback_type feedback_type,
    comment TEXT NOT NULL,
    reservation_id UUID REFERENCES public.reservations(id) ON DELETE SET NULL,
    tags TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Activity Log
CREATE TABLE public.activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    activity_type TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Promo Codes
CREATE TABLE public.promo_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
    description TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    max_usage INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Staff Users
CREATE TABLE public.staff_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, -- Never store plain text in real DB
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role staff_role NOT NULL DEFAULT 'cashier',
    is_admin BOOLEAN NOT NULL DEFAULT false,
    phone TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rates Configuration (Single Row Table)
CREATE TABLE public.rates_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hourly_rate DECIMAL(10, 2) NOT NULL,
    happy_hour_rate DECIMAL(10, 2) NOT NULL,
    happy_hour_start TIME NOT NULL,
    happy_hour_end TIME NOT NULL,
    overtime_rate DECIMAL(10, 2) NOT NULL,
    down_payment_percent INTEGER NOT NULL DEFAULT 25,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reservation Terms (Single Row Table)
CREATE TABLE public.reservation_terms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    min_hours INTEGER NOT NULL DEFAULT 1,
    max_hours INTEGER NOT NULL DEFAULT 8,
    min_party_size INTEGER NOT NULL DEFAULT 1,
    max_party_size INTEGER NOT NULL DEFAULT 10,
    cancellation_hours INTEGER NOT NULL DEFAULT 24,
    cancellation_policy TEXT NOT NULL,
    terms_and_conditions TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Announcements
CREATE TABLE public.announcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type announcement_type NOT NULL DEFAULT 'info',
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Closed Dates
CREATE TABLE public.closed_dates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    closed_date DATE NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    is_full_day BOOLEAN NOT NULL DEFAULT true,
    open_time TIME,
    close_time TIME,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Website CMS
-- The live table uses lower-case column names because it was created through
-- PostgREST. `dateAdded` is quoted so the camelCase API name is preserved.
CREATE TABLE public.cms (
    keyname TEXT PRIMARY KEY,
    settingvalue TEXT,
    updatedat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "dateAdded" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.cms_set_date_added()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."dateAdded" := COALESCE(NEW."dateAdded", NEW.updatedat, NOW());
  ELSE
    NEW."dateAdded" := OLD."dateAdded";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cms_set_date_added
  BEFORE INSERT OR UPDATE ON public.cms
  FOR EACH ROW
  EXECUTE FUNCTION public.cms_set_date_added();

-- 4. RLS POLICIES (Row Level Security - Basic structure)
-- Note: Replace placeholders or logic depending on how you use JWT auth in Supabase.
-- By default, all tables are locked down if enabled. You can open them as needed.

ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read for all authenticated users" ON public.tables FOR SELECT USING (auth.role() = 'authenticated');
-- Enable write... (Admin/Manager logic would apply here)

-- Ensure updated_at sync triggers exist in production.