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

  const [paymentImage, setPaymentImage] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isOpen) return null;

  // File upload enabled ONLY for these 3 plans
  const paidPlans = ['Bike Basic', 'Car Basic', 'Car Pro'];
  const isPaidPlanSelected = paidPlans.includes(formData.preferredService);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setPaymentImage(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    const bodyData = new FormData();
    Object.entries(formData).forEach(([key, value]) => {
      bodyData.append(key, value);
    });

    if (isPaidPlanSelected && paymentImage) {
      bodyData.append('paymentImage', paymentImage);
    }

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        body: bodyData,
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setMessage({ type: 'success', text: result.message });
        setTimeout(() => {
          onClose();
          setMessage(null);
        }, 2000);
      } else {
        setMessage({ type: 'error', text: result.message || 'Submission failed.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden border border-gray-100">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">Book Your Wash</h2>
          <button 
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none font-medium"
          >
            &times;
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
          {message && (
            <div className={`p-3 rounded-lg text-sm font-medium ${
              message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
            }`}>
              {message.text}
            </div>
          )}

          {/* Full Name & Email */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Full Name *</label>
              <input
                type="text"
                name="name"
                required
                placeholder="John Doe"
                value={formData.name}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Email Address *</label>
              <input
                type="email"
                name="email"
                required
                placeholder="john@example.com"
                value={formData.email}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>
          </div>

          {/* Mobile & Datalist Location Input */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Mobile Number *</label>
              <input
                type="tel"
                name="mobile"
                required
                placeholder="10-digit number"
                value={formData.mobile}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>

            {/* Hybrid Input: Dropdown selection + Custom typing option */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Location / Society *</label>
              <input
                type="text"
                name="location"
                list="society-options"
                required
                placeholder="Select or type location..."
                value={formData.location}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
              <datalist id="society-options">
                <option value="Yashwin Orizzonte - A Wing" />
                <option value="Yashwin Orizzonte - B Wing" />
                <option value="Yashwin Orizzonte - C Wing" />
                <option value="Yashwin Orizzonte - D Wing" />
              </datalist>
            </div>
          </div>

          {/* Flat Number & Registration Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Flat No. *</label>
              <input
                type="text"
                name="flatNumber"
                required
                placeholder="e.g. A-101"
                value={formData.flatNumber}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Vehicle Registration No. *</label>
              <input
                type="text"
                name="vehicleRegistrationNumber"
                required
                placeholder="MH 12 AB 1234"
                value={formData.vehicleRegistrationNumber}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm uppercase focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>
          </div>

          {/* Vehicle Type & Model */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Vehicle Type *</label>
              <select
                name="vehicleType"
                value={formData.vehicleType}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              >
                <option value="Car">Car</option>
                <option value="Bike">Bike</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Vehicle Model *</label>
              <input
                type="text"
                name="vehicleModel"
                required
                placeholder="e.g. Swift, Nexon, Activa"
                value={formData.vehicleModel}
                onChange={handleChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
              />
            </div>
          </div>

          {/* Service Selection */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Select Service *</label>
            <select
              name="preferredService"
              value={formData.preferredService}
              onChange={handleChange}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 text-gray-900"
            >
              <option value="Free Wash">Free Wash</option>
              <option value="Bike Basic">Bike Basic</option>
              <option value="Car Basic">Car Basic</option>
              <option value="Car Pro">Car Pro</option>
              <option value="Custom Plan">Custom Plan</option>
            </select>
          </div>

          {/* File Upload for Paid Plans vs Contact Notice for Custom/Free */}
          {isPaidPlanSelected ? (
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Payment Screenshot *</label>
              <input
                type="file"
                accept="image/*"
                required
                onChange={handleFileChange}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </div>
          ) : (
            <div className="p-3 bg-blue-50/80 border border-blue-200/60 rounded-xl text-blue-800 text-xs font-medium flex items-center gap-2">
              <span>ℹ️</span>
              <span>Our team will contact you soon regarding your booking!</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 text-sm font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-md shadow-blue-500/20"
            >
              {isSubmitting ? 'Submitting...' : 'Book Wash'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};