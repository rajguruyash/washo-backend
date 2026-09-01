// API service for lead submission and other backend interactions

const API_BASE_URL = import.meta.env.VITE_API_URL;

/**
 * Lead data received from the frontend form.
 */
interface LeadData {
  name: string;
  phone: string;
  vehicleType: string;
  vehicleModel: string;
  location: string;
  preferredService: string;
  source?: string;
  timestamp?: string;
}

/**
 * Submit lead data to the backend.
 *
 * Frontend fields are camelCase, while the backend/PostgreSQL API
 * expects snake_case field names.
 *
 * Flow:
 * Frontend → POST /api/leads → Express → PostgreSQL
 */
export const submitLead = async (leadData: LeadData): Promise<any> => {
  if (!API_BASE_URL) {
    throw new Error(
      'VITE_API_URL environment variable is not set. Please configure it in .env.'
    );
  }

  const backendData = {
    name: leadData.name.trim(),
    mobile: leadData.phone.replace(/\s+/g, ''),
    vehicle_type: leadData.vehicleType,
    vehicle_model: leadData.vehicleModel.trim(),
    location: leadData.location.trim(),
    preferred_service: leadData.preferredService,
    source: leadData.source || 'website',
    timestamp: leadData.timestamp || new Date().toISOString(),
  };

  console.log('Submitting lead to:', `${API_BASE_URL}/leads`);
  console.log('Lead data:', backendData);

  try {
    const response = await fetch(`${API_BASE_URL}/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(backendData),
    });

    const responseText = await response.text();

    console.log('Backend response status:', response.status);
    console.log('Backend response:', responseText);

    let responseData: any;

    try {
      responseData = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseData = {
        message: responseText,
      };
    }

    if (!response.ok) {
      throw new Error(
        responseData?.message ||
        responseData?.error ||
        `Lead submission failed with HTTP ${response.status}`
      );
    }

    return responseData;
  } catch (error) {
    console.error('Lead submission error:', error);
    throw error;
  }
};

/**
 * Get service area information.
 */
export const getServiceArea = async (): Promise<any> => {
  if (!API_BASE_URL) {
    throw new Error(
      'VITE_API_URL environment variable is not set. Please configure it in .env.'
    );
  }

  try {
    const response = await fetch(`${API_BASE_URL}/service-area`);

    const responseText = await response.text();

    let responseData: any;

    try {
      responseData = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseData = {
        message: responseText,
      };
    }

    if (!response.ok) {
      throw new Error(
        responseData?.message ||
        responseData?.error ||
        `Request failed with HTTP ${response.status}`
      );
    }

    return responseData;
  } catch (error) {
    console.error('Service area API error:', error);
    throw error;
  }
};

export default {
  submitLead,
  getServiceArea,
};