-- Create leads table
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL,
  vehicle_model VARCHAR(100) NOT NULL,
  location VARCHAR(255) NOT NULL,
  preferred_service VARCHAR(100) NOT NULL,
  source VARCHAR(100) DEFAULT 'website',
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on mobile for faster lookups
CREATE INDEX IF NOT EXISTS idx_leads_mobile ON leads(mobile);

-- Create index on timestamp for recent leads
CREATE INDEX IF NOT EXISTS idx_leads_timestamp ON leads(timestamp DESC);

-- Add comment to table
COMMENT ON TABLE leads IS 'Store WASHO website lead submissions';

-- Add comments to columns
COMMENT ON COLUMN leads.id IS 'Unique identifier for the lead';
COMMENT ON COLUMN leads.name IS 'Full name of the lead';
COMMENT ON COLUMN leads.mobile IS 'Mobile number (10 digits, Indian format)';
COMMENT ON COLUMN leads.vehicle_type IS 'Type of vehicle (car/bike/etc.)';
COMMENT ON COLUMN leads.vehicle_model IS 'Specific vehicle model';
COMMENT ON COLUMN leads.location IS 'Location/area of the lead';
COMMENT ON COLUMN leads.preferred_service IS 'Service the lead is interested in';
COMMENT ON COLUMN leads.source IS 'Source of the lead';
COMMENT ON COLUMN leads.timestamp IS 'When the lead was submitted';
