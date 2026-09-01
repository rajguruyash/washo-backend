import { useState } from 'react';
import type { FormEvent } from 'react';
import { getStoredSourceParam } from '../lib/tracking';
import { submitLead } from '../lib/api';

interface LeadFormProps {
  onClose?: () => void;
}

const LeadForm = ({ onClose }: LeadFormProps) => {
  const [formState, setFormState] = useState({
    name: '',
    phone: '',
    vehicleType: '',
    vehicleModel: '',
    location: '',
    preferredService: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Get source from storage (set by tracking service on load)
  const source = getStoredSourceParam();

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!formState.name.trim()) {
      errors.name = 'Name is required';
    }
    if (!formState.phone.trim()) {
      errors.phone = 'Mobile number is required';
    } else {
      // Remove spaces and non-digits
      const cleaned = formState.phone.replace(/\s+/g, '');
      // Indian mobile number: 10 digits, starting with 6-9
      if (!/^[6-9]\d{9}$/.test(cleaned)) {
        errors.phone = 'Please enter a valid 10-digit mobile number';
      }
    }
    if (!formState.vehicleType) {
      errors.vehicleType = 'Vehicle type is required';
    }
    if (!formState.vehicleModel.trim()) {
      errors.vehicleModel = 'Vehicle model is required';
    }
    if (!formState.location.trim()) {
      errors.location = 'Location is required';
    }
    if (!formState.preferredService) {
      errors.preferredService = 'Preferred service is required';
    }
    return errors;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);
    setError('');

    try {
      // Prepare lead data with source parameter
      const leadData = {
        ...formState,
        source: source,
        timestamp: new Date().toISOString(),
      };

      // Submit to API
      await submitLead(leadData);

      // Reset form and show success
      setFormState({
        name: '',
        phone: '',
        vehicleType: '',
        vehicleModel: '',
        location: '',
        preferredService: '',
      });
      setIsSuccess(true);
    } catch (err) {
      setError('Failed to submit lead. Please try again.');
      console.error('Lead submission error:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="bg-washo-lightest rounded-xl p-8 text-center">
        <div className="mb-6">
          <span className="text-washo-blue text-4xl">🎉</span>
        </div>
        <h3 className="font-heading font-bold text-washo-blue text-xl mb-4">
          YOU'RE IN!
        </h3>
        <p className="text-washo-dark mb-2">
          Your Washo request has been received.
        </p>
        <p className="text-washo-dark">
          We'll contact you shortly to confirm your first wash.
        </p>
        <button
          onClick={() => {
            onClose?.();
          }}
          className="btn-outline mt-6"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <section id="lead-form" className="bg-white">
      <div className="w-full">
        <h2 className="text-3xl font-bold uppercase text-washo-blue mb-6">
          GET YOUR FIRST WASH FREE
        </h2>

        <p className="text-washo-dark text-center text-lg mb-6">
          Tell us a little about your vehicle and we'll get in touch.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="form-label mb-2">Name</label>
              <input
                type="text"
                className="form-input h-11"
                placeholder="Enter your full name"
                value={formState.name}
                onChange={(e) => setFormState({ ...formState, name: e.target.value })}
                required
              />
              {fieldErrors.name && (
                <p className="text-red-500 text-sm mt-1">{fieldErrors.name}</p>
              )}
            </div>

            <div>
              <label className="form-label mb-2">Mobile Number</label>
              <input
                type="tel"
                className="form-input h-11"
                placeholder="Enter your mobile number"
                value={formState.phone}
                onChange={(e) => setFormState({ ...formState, phone: e.target.value })}
                required
              />
              {fieldErrors.phone && (
                <p className="text-red-500 text-sm mt-1">{fieldErrors.phone}</p>
              )}
            </div>
          </div>

          <div>
            <label className="form-label mb-2">Vehicle Type</label>
            <select
              className="form-input h-11"
              value={formState.vehicleType}
              onChange={(e) => setFormState({ ...formState, vehicleType: e.target.value })}
              required
            >
              <option value="">Select vehicle type</option>
              <option value="car">Car</option>
              <option value="bike">Bike</option>
            </select>
            {fieldErrors.vehicleType && (
              <p className="text-red-500 text-sm mt-1">{fieldErrors.vehicleType}</p>
            )}
          </div>

          <div>
            <label className="form-label mb-2">Vehicle Model</label>
            <input
              type="text"
              className="form-input h-11"
              placeholder="Enter vehicle model (e.g., Honda City, Royal Enfield)"
              value={formState.vehicleModel}
              onChange={(e) => setFormState({ ...formState, vehicleModel: e.target.value })}
              required
            />
            {fieldErrors.vehicleModel && (
              <p className="text-red-500 text-sm mt-1">{fieldErrors.vehicleModel}</p>
            )}
          </div>

          <div>
            <label className="form-label mb-2">Location</label>
            <input
              type="text"
              className="form-input h-11"
              placeholder="Enter your area/location"
              value={formState.location}
              onChange={(e) => setFormState({ ...formState, location: e.target.value })}
              required
            />
            {fieldErrors.location && (
              <p className="text-red-500 text-sm mt-1">{fieldErrors.location}</p>
            )}
          </div>

          <div>
            <label className="form-label mb-2">Preferred Service</label>
            <select
              className="form-input h-11"
              value={formState.preferredService}
              onChange={(e) => setFormState({ ...formState, preferredService: e.target.value })}
              required
            >
              <option value="">Select preferred service</option>
              <option value="first-wash">First Wash</option>
              <option value="bike-plan">Bike Plan</option>
              <option value="car-basic-plan">Car Basic Plan</option>
              <option value="car-pro-plan">Car Pro Plan</option>
              <option value="custom-plan">Custom Plan</option>
            </select>
            {fieldErrors.preferredService && (
              <p className="text-red-500 text-sm mt-1">{fieldErrors.preferredService}</p>
            )}
          </div>

          {/* Show source tracking info for debugging - would be hidden in production */}
          {source && import.meta.env.DEV && (
            <div className="text-xs text-washo-dark/50 text-center mb-4">
              Source: {source}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Submitting...' : 'CLAIM MY FREE WASH'}
          </button>

          {error && (
            <p className="text-red-500 text-center mt-4">
              {error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
};

export default LeadForm;