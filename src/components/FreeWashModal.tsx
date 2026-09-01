import React, { useState } from 'react';

interface FreeWashModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function FreeWashModal({ isOpen, onClose }: FreeWashModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [vehicleType, setVehicleType] = useState('Hatchback');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehicleRegistrationNumber, setVehicleRegistrationNumber] = useState('');
  const [location, setLocation] = useState('');
  const [flatNumber, setFlatNumber] = useState('');
  const [preferredService, setPreferredService] = useState('First Wash');
  const [paymentImage, setPaymentImage] = useState<File | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const submitLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    // Email Regex Validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      setIsSubmitting(false);
      return;
    }

    // Payment validation
    if (preferredService !== 'First Wash' && !paymentImage) {
      setError('Payment screenshot is required for this plan.');
      setIsSubmitting(false);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('email', email);
      formData.append('mobile', mobile);
      formData.append('vehicleType', vehicleType);
      formData.append('vehicleModel', vehicleModel);
      formData.append('vehicleRegistrationNumber', vehicleRegistrationNumber);
      formData.append('location', location);
      formData.append('flatNumber', flatNumber);
      formData.append('preferredService', preferredService);
      formData.append('source', 'website');
      formData.append('timestamp', new Date().toISOString());

      if (preferredService !== 'First Wash' && paymentImage) {
        formData.append('paymentImage', paymentImage);
      }

      const response = await fetch('https://washo.onrender.com/api/leads', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSuccess(true);
      } else {
        setError(data.message || 'Submission failed');
      }
    } catch (err) {
      setError('A network error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/75 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 relative">
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-800 font-bold"
        >
          ✕
        </button>

        <h2 className="text-2xl font-bold mb-4 text-gray-800">Book Your Wash</h2>

        {success ? (
          <div className="text-center py-8">
            <div className="text-green-500 text-5xl mb-4">✓</div>
            <h3 className="text-xl font-semibold mb-2">Booking Successful!</h3>
            <p className="text-gray-600 mb-6">We will contact you shortly to confirm your slot.</p>
            <button onClick={onClose} className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium">Close</button>
          </div>
        ) : (
          <form onSubmit={submitLead} className="space-y-4">
            {error && <div className="bg-red-50 text-red-600 p-3 rounded text-sm">{error}</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Full Name *</label>
                <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="John Doe" />
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Email Address *</label>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="john@example.com" />
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Mobile Number *</label>
                <input type="tel" required value={mobile} onChange={(e) => setMobile(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="10-digit number" />
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Location / Society *</label>
                <input list="locations-list" required value={location} onChange={(e) => setLocation(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="Select or type location" />
                <datalist id="locations-list">
                  <option value="Yashwin Orizzonte Wing A" />
                  <option value="Yashwin Orizzonte Wing B" />
                  <option value="Yashwin Orizzonte Wing C" />
                  <option value="Yashwin Orizzonte Wing D" />
                </datalist>
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Flat No. *</label>
                <input type="text" required value={flatNumber} onChange={(e) => setFlatNumber(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="e.g. A-101" />
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Vehicle Registration No. *</label>
                <input type="text" required value={vehicleRegistrationNumber} onChange={(e) => setVehicleRegistrationNumber(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="MH 12 AB 1234" />
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Vehicle Type *</label>
                <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500">
                  <option value="Hatchback">Hatchback</option>
                  <option value="Sedan">Sedan</option>
                  <option value="SUV">SUV</option>
                  <option value="Luxury">Luxury</option>
                </select>
              </div>

              <div className="flex flex-col">
                <label className="text-sm font-medium mb-1">Vehicle Model *</label>
                <input type="text" required value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500" placeholder="e.g. Swift, Nexon" />
              </div>

              <div className="flex flex-col col-span-1 md:col-span-2">
                <label className="text-sm font-medium mb-1">Select Service *</label>
                <select value={preferredService} onChange={(e) => setPreferredService(e.target.value)} className="border rounded px-3 py-2 focus:ring-2 focus:ring-blue-500">
                  <option value="First Wash">Free First Wash</option>
                  <option value="Basic Monthly">Basic Monthly Plan</option>
                  <option value="Premium Monthly">Premium Monthly Plan</option>
                </select>
              </div>

              {/* Conditional File Upload */}
              {preferredService !== 'First Wash' && (
                <div className="flex flex-col col-span-1 md:col-span-2 bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <label className="text-sm font-medium mb-2 text-gray-800">Upload Payment Screenshot * (Max 5MB)</label>
                  <input 
                    type="file" 
                    accept="image/jpeg, image/jpg, image/png, image/webp"
                    required 
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file && file.size > 5 * 1024 * 1024) {
                        alert('File size exceeds 5MB');
                        e.target.value = ''; // reset
                      } else {
                        setPaymentImage(file || null);
                      }
                    }} 
                    className="text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  />
                  <p className="text-xs text-gray-500 mt-2">Accepted formats: JPG, PNG, WEBP.</p>
                </div>
              )}
            </div>

            <div className="pt-4 border-t mt-6 flex justify-end gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded font-medium">Cancel</button>
              <button 
                type="submit" 
                disabled={isSubmitting}
                className="px-6 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {isSubmitting ? 'Submitting...' : 'Book Wash'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}