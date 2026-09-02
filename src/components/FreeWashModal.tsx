import React, { useState } from 'react';

interface FreeWashModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FreeWashModal: React.FC<FreeWashModalProps> = ({ isOpen, onClose }) => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    mobile: '',
    location: '',
    flatNumber: '',
    vehicleRegistrationNumber: '',
    vehicleType: 'Car',
    vehicleModel: '',
    preferredService: 'Free Wash',
  });

  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Automatically transform registration input to UPPERCASE
  const handleRegNoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      vehicleRegistrationNumber: e.target.value.toUpperCase(),
    }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setPaymentFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setIsSubmitting(true);

    try {
      const dataPayload = new FormData();
      dataPayload.append('name', formData.name);
      dataPayload.append('email', formData.email);
      dataPayload.append('mobile', formData.mobile);
      dataPayload.append('location', formData.location);
      dataPayload.append('flatNumber', formData.flatNumber);
      dataPayload.append('vehicleRegistrationNumber', formData.vehicleRegistrationNumber.trim().toUpperCase());
      dataPayload.append('vehicleType', formData.vehicleType);
      dataPayload.append('vehicleModel', formData.vehicleModel);
      dataPayload.append('preferredService', formData.preferredService);

      if (formData.preferredService !== 'Free Wash') {
        if (!paymentFile) {
          setErrorMessage('Please upload a payment screenshot for paid plans.');
          setIsSubmitting(false);
          return;
        }
        dataPayload.append('paymentImage', paymentFile);
      }

      const response = await fetch('/api/leads', {
        method: 'POST',
        body: dataPayload,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setErrorMessage(data.message || 'An error occurred while submitting.');
        setIsSubmitting(false);
        return;
      }

      alert('Booking submitted successfully!');
      onClose();
    } catch (err) {
      setErrorMessage('Network error. Please try again later.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="close-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <h3 className="text-xl font-bold text-washo-blue">Book Your Wash</h3>

        {errorMessage && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-xs sm:text-sm mt-3 font-medium">
            {errorMessage}
          </div>
        )}

        <div className="modal-body">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="form-label">Full Name *</label>
                <input
                  type="text"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="John Doe"
                  className="form-input"
                />
              </div>

              <div>
                <label className="form-label">Email Address *</label>
                <input
                  type="email"
                  name="email"
                  required
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="john@example.com"
                  className="form-input"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="form-label">Mobile Number *</label>
                <input
                  type="tel"
                  name="mobile"
                  required
                  value={formData.mobile}
                  onChange={handleChange}
                  placeholder="10-digit number"
                  className="form-input"
                />
              </div>

              <div>
                <label className="form-label">Location / Society *</label>
                <input
                  type="text"
                  name="location"
                  required
                  value={formData.location}
                  onChange={handleChange}
                  placeholder="Select or type location"
                  className="form-input"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="form-label">Flat No. *</label>
                <input
                  type="text"
                  name="flatNumber"
                  required
                  value={formData.flatNumber}
                  onChange={handleChange}
                  placeholder="e.g. A-101"
                  className="form-input"
                />
              </div>

              {/* Vehicle Registration Field with Auto-Uppercase */}
              <div>
                <label className="form-label">Vehicle Registration No. *</label>
                <input
                  type="text"
                  name="vehicleRegistrationNumber"
                  required
                  value={formData.vehicleRegistrationNumber}
                  onChange={handleRegNoChange}
                  placeholder="MH 12 AB 1234"
                  className="form-input uppercase"
                  style={{ textTransform: 'uppercase' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Updated Vehicle Type Dropdown */}
              <div>
                <label className="form-label">Vehicle Type *</label>
                <select
                  name="vehicleType"
                  value={formData.vehicleType}
                  onChange={handleChange}
                  className="form-input"
                >
                  <option value="Car">Car</option>
                  <option value="Bike">Bike</option>
                </select>
              </div>

              <div>
                <label className="form-label">Vehicle Model *</label>
                <input
                  type="text"
                  name="vehicleModel"
                  required
                  value={formData.vehicleModel}
                  onChange={handleChange}
                  placeholder="e.g. Swift, Nexon, Activa"
                  className="form-input"
                />
              </div>
            </div>

            {/* Updated Service Plans Dropdown */}
            <div>
              <label className="form-label">Select Service *</label>
              <select
                name="preferredService"
                value={formData.preferredService}
                onChange={handleChange}
                className="form-input"
              >
                <option value="Bike Plan">Bike Plan</option>
                <option value="Car Basic">Car Basic</option>
                <option value="Car Pro">Car Pro</option>
                <option value="Custom">Custom</option>
                <option value="Free Wash">Free Wash</option>
              </select>
            </div>

            {formData.preferredService !== 'Free Wash' && (
              <div>
                <label className="form-label">Payment Screenshot *</label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  required
                  className="form-input text-xs sm:text-sm"
                />
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <button type="button" onClick={onClose} className="btn-outline px-4 py-2 text-sm">
                Cancel
              </button>
              <button type="submit" disabled={isSubmitting} className="btn-primary px-6 py-2 text-sm">
                {isSubmitting ? 'Checking...' : 'Book Wash'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};