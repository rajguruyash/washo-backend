import React, { useState } from 'react';

interface FreeWashModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const initialFormState = {
  name: '',
  email: '',
  mobile: '',
  location: 'Yashwin Orizzonte - A Wing',
  flatNumber: '',
  vehicleRegistrationNumber: '',
  vehicleType: 'Car',
  vehicleModel: '',
  preferredService: 'Free Wash',
};

export const FreeWashModal: React.FC<FreeWashModalProps> = ({ isOpen, onClose }) => {
  const [formData, setFormData] = useState(initialFormState);
  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!isOpen) return null;

  const resetForm = () => {
    setFormData(initialFormState);
    setPaymentFile(null);
    setErrorMessage('');
    setIsSuccess(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

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

      setIsSuccess(true);
    } catch (err) {
      setErrorMessage('Network error. Please try again later.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={handleClose}
    >
      <div 
        className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-100 transition-all my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <h3 className="text-xl font-bold text-slate-800 tracking-tight">Book Your Wash</h3>
          <button 
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6">
          {isSuccess ? (
            <div className="py-8 text-center space-y-4">
              <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-2xl font-bold">
                ✓
              </div>
              <h4 className="text-xl font-bold text-slate-800">Booking Submitted!</h4>
              <p className="text-sm text-slate-600 max-w-md mx-auto">
                Thank you! We have received your booking request for vehicle registration{' '}
                <span className="font-semibold text-slate-800">{formData.vehicleRegistrationNumber}</span>.
              </p>
              <div className="pt-4">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl text-sm transition-all shadow-md shadow-blue-500/20"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              {errorMessage && (
                <div className="mb-5 p-3.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs sm:text-sm font-medium flex items-start gap-2">
                  <span className="font-bold">⚠️</span>
                  <span>{errorMessage}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name *</label>
                    <input
                      type="text"
                      name="name"
                      required
                      value={formData.name}
                      onChange={handleChange}
                      placeholder="John Doe"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Email Address *</label>
                    <input
                      type="email"
                      name="email"
                      required
                      value={formData.email}
                      onChange={handleChange}
                      placeholder="john@example.com"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Mobile Number *</label>
                    <input
                      type="tel"
                      name="mobile"
                      required
                      value={formData.mobile}
                      onChange={handleChange}
                      placeholder="10-digit number"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Location / Society *</label>
                    <select
                      name="location"
                      value={formData.location}
                      onChange={handleChange}
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    >
                      <option value="Yashwin Orizzonte - A Wing">Yashwin Orizzonte - A Wing</option>
                      <option value="Yashwin Orizzonte - B Wing">Yashwin Orizzonte - B Wing</option>
                      <option value="Yashwin Orizzonte - C Wing">Yashwin Orizzonte - C Wing</option>
                      <option value="Yashwin Orizzonte - D Wing">Yashwin Orizzonte - D Wing</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Flat No. *</label>
                    <input
                      type="text"
                      name="flatNumber"
                      required
                      value={formData.flatNumber}
                      onChange={handleChange}
                      placeholder="e.g. A-101"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Vehicle Registration No. *</label>
                    <input
                      type="text"
                      name="vehicleRegistrationNumber"
                      required
                      value={formData.vehicleRegistrationNumber}
                      onChange={handleRegNoChange}
                      placeholder="MH 12 AB 1234"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl uppercase font-mono tracking-wider focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Vehicle Type *</label>
                    <select
                      name="vehicleType"
                      value={formData.vehicleType}
                      onChange={handleChange}
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    >
                      <option value="Car">Car</option>
                      <option value="Bike">Bike</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Vehicle Model *</label>
                    <input
                      type="text"
                      name="vehicleModel"
                      required
                      value={formData.vehicleModel}
                      onChange={handleChange}
                      placeholder="e.g. Swift, Nexon, Activa"
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Select Service *</label>
                  <select
                    name="preferredService"
                    value={formData.preferredService}
                    onChange={handleChange}
                    className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                  >
                    <option value="Free Wash">Free Wash</option>
                    <option value="Bike Plan">Bike Plan</option>
                    <option value="Car Basic">Car Basic</option>
                    <option value="Car Pro">Car Pro</option>
                    <option value="Custom">Custom</option>
                  </select>
                </div>

                {formData.preferredService !== 'Free Wash' && (
                  <div className="p-3 bg-blue-50/50 border border-blue-100 rounded-xl">
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">Payment Screenshot *</label>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleFileChange}
                      required
                      className="block w-full text-xs text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
                    />
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 mt-6">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-xl shadow-md shadow-blue-500/20 disabled:opacity-50 transition"
                  >
                    {isSubmitting ? 'Checking...' : 'Book Wash'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default FreeWashModal;