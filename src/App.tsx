import { useState } from 'react';
import FreeWashModal from './components/FreeWashModal';

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [, setSelectedPlan] = useState('First Wash');

  const handleOpenModal = (planName = 'First Wash') => {
    setSelectedPlan(planName);
    setIsModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased">
      {/* 1. Header Navigation */}
      <header className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white/95 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-4xl font-black italic tracking-wider text-blue-600">WASHO</span>
            <span className="bg-blue-100 text-blue-800 text-xs font-extrabold px-3 py-1 rounded-full uppercase tracking-wider">
              Kharadi
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-10 font-bold text-base text-slate-700">
            <a href="#why-washo" className="hover:text-blue-600 transition-colors">Why Choose Us</a>
            <a href="#plans" className="hover:text-blue-600 transition-colors">Monthly Plans</a>
            <a href="#comparison" className="hover:text-blue-600 transition-colors">Services Table</a>
            <a href="#contact" className="hover:text-blue-600 transition-colors">Contact</a>
          </nav>

          <div className="flex items-center gap-4">
            <a
              href="tel:8668890147"
              className="hidden lg:inline-flex items-center gap-2 text-sm font-bold text-slate-800 hover:text-blue-600 transition-colors"
            >
              📞 8668890147
            </a>
            <button
              onClick={() => handleOpenModal('First Wash')}
              className="bg-blue-600 hover:bg-blue-700 hover:scale-105 text-white font-bold text-base px-6 py-3 rounded-full shadow-lg hover:shadow-blue-600/30 transition-all active:scale-95"
            >
              Claim Free Wash
            </button>
          </div>
        </div>
      </header>

      {/* 2. Hero Section */}
      <section className="bg-white border-b border-slate-200 py-16 lg:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          
          {/* Left Text Column */}
          <div className="lg:col-span-7 space-y-6">
            <span className="inline-block text-xs sm:text-sm font-extrabold tracking-widest text-blue-600 uppercase bg-blue-50 px-4 py-1.5 rounded-full border border-blue-100">
              Clean Today, Shine Everyday
            </span>

            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black text-slate-900 tracking-tight leading-none">
              CLEAN VEHICLES. <br />
              <span className="text-blue-600">HAPPY YOU.</span>
            </h1>

            <p className="text-lg sm:text-xl text-slate-600 font-medium leading-relaxed max-w-2xl">
              Professional doorstep car & bike washing at your location in Kharadi. We bring high-pressure equipment right to your parking slot.
            </p>

            {/* Flyer Free Wash Box - Interactive */}
            <div className="bg-gradient-to-r from-yellow-400 to-amber-400 rounded-3xl p-6 text-slate-900 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl hover:shadow-amber-400/20">
              <div className="flex items-center gap-4">
                <span className="text-4xl animate-bounce">🎁</span>
                <div>
                  <h4 className="font-black text-xl uppercase tracking-wide leading-tight">First Wash Free!</h4>
                  <p className="text-sm font-bold text-slate-800 mt-1">Experience WASHO with your first wash absolutely free.</p>
                </div>
              </div>
              <button
                onClick={() => handleOpenModal('First Wash')}
                className="bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold px-6 py-3.5 rounded-2xl whitespace-nowrap shadow-md transition-all active:scale-95 w-full sm:w-auto text-center"
              >
                Claim Now
              </button>
            </div>
          </div>

          {/* Right Highlight Card - Interactive */}
          <div className="lg:col-span-5 bg-gradient-to-br from-blue-900 via-slate-900 to-slate-950 text-white rounded-3xl p-8 shadow-2xl border border-blue-800/60 transition-all duration-300 hover:-translate-y-2 hover:shadow-blue-900/30">
            <div className="flex items-center justify-between pb-6 border-b border-slate-800">
              <div>
                <p className="text-xs font-bold text-blue-400 uppercase tracking-widest">Doorstep Care</p>
                <h3 className="text-2xl font-black mt-0.5">WASHO Premium Care</h3>
              </div>
              <span className="bg-emerald-500/20 text-emerald-300 text-xs font-bold px-3 py-1.5 rounded-full border border-emerald-500/30">
                Active in Kharadi
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 my-8">
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 transition-all hover:bg-white/10 hover:scale-105">
                <p className="text-xs text-slate-400">Pressure Foam</p>
                <p className="font-bold text-white text-base mt-1">Scratch-Free</p>
              </div>
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 transition-all hover:bg-white/10 hover:scale-105">
                <p className="text-xs text-slate-400">Eco Friendly</p>
                <p className="font-bold text-white text-base mt-1">Saves Water</p>
              </div>
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 transition-all hover:bg-white/10 hover:scale-105">
                <p className="text-xs text-slate-400">Verified Staff</p>
                <p className="font-bold text-white text-base mt-1">Skilled Crew</p>
              </div>
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 transition-all hover:bg-white/10 hover:scale-105">
                <p className="text-xs text-slate-400">Monthly Plans</p>
                <p className="font-bold text-white text-base mt-1">Save Up To ₹500</p>
              </div>
            </div>

            <button
              onClick={() => handleOpenModal('First Wash')}
              className="w-full bg-blue-600 hover:bg-blue-500 font-extrabold text-base py-4 rounded-2xl text-center transition-all shadow-xl shadow-blue-600/30 active:scale-95"
            >
              Book Your Free Trial Slot
            </button>
          </div>

        </div>
      </section>

      {/* 3. Why Choose WASHO? (Interactive Cards) */}
      <section id="why-washo" className="py-20 bg-slate-50 border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-sm font-extrabold tracking-widest text-blue-600 uppercase">The WASHO Advantage</h2>
            <p className="text-3xl sm:text-4xl font-black text-slate-900 mt-2">Why Choose WASHO?</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
            {[
              { icon: '🏠', title: 'Doorstep Service', desc: 'We come to you. No travel, no hassle.' },
              { icon: '👥', title: 'No Waiting', desc: 'No queues, no crowds. Just you.' },
              { icon: '💧', title: 'Low Water Usage', desc: 'We save water, you save nature.' },
              { icon: '🌿', title: 'Eco-friendly Products', desc: 'Safe for your vehicle & environment.' },
              { icon: '🛡️', title: 'Safe for Paint & Parts', desc: 'Gentle care for a longer shine.' },
              { icon: '👤', title: 'Trained & Verified Staff', desc: 'Skilled professionals you trust.' }
            ].map((item, idx) => (
              <div 
                key={idx} 
                className="bg-white p-6 rounded-3xl border border-slate-200 text-center flex flex-col items-center justify-start shadow-sm cursor-pointer transition-all duration-300 hover:-translate-y-2 hover:shadow-xl hover:border-blue-400 group"
              >
                <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl mb-4 transition-transform duration-300 group-hover:scale-125 group-hover:bg-blue-600 group-hover:text-white">
                  {item.icon}
                </div>
                <h3 className="font-bold text-slate-900 text-sm mb-2 group-hover:text-blue-600 transition-colors">{item.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4. Pricing Plans (Unified Default Colors, Hidden/Popping Tag, Bright Flyer Yellow) */}
      <section id="plans" className="py-20 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-sm font-extrabold tracking-widest text-blue-600 uppercase">Transparent Pricing</h2>
            <p className="text-3xl sm:text-4xl font-black text-slate-900 mt-2">Choose the Plan That Suits You Best</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 items-stretch">
            
            {/* Bike Plan */}
            <div 
              onClick={() => handleOpenModal('Bike Plan - ₹999')}
              className="bg-slate-50 border border-slate-200 rounded-3xl p-8 flex flex-col justify-between relative shadow-sm cursor-pointer transition-all duration-300 ease-out hover:-translate-y-3 hover:shadow-2xl hover:border-blue-400 group"
            >
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl transition-transform duration-300 group-hover:scale-125">🏍️</span>
                  <h3 className="font-black text-xl text-slate-900">BIKE PLAN</h3>
                </div>
                <p className="text-xs font-bold text-slate-500 uppercase">Standard Wash</p>
                <span className="inline-block bg-blue-100 text-blue-800 text-xs font-extrabold px-3 py-1.5 rounded-lg my-4">
                  16 WASHES / MONTH
                </span>
                <p className="text-sm text-slate-600 font-semibold mb-6">4 Washes Every Week</p>

                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-4xl font-black text-slate-900">₹999</span>
                  <span className="text-base font-normal text-slate-400 line-through">₹1,199</span>
                  <span className="bg-yellow-400 text-slate-950 font-extrabold text-xs px-2.5 py-1 rounded-md shadow-sm">SAVE ₹200</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">Per Wash Cost: ₹62.44</p>
              </div>

              <button className="mt-8 w-full bg-slate-900 group-hover:bg-blue-600 text-white font-bold text-sm py-4 rounded-2xl transition-colors">
                Select Bike Plan
              </button>
            </div>

            {/* Car Basic Plan (Standard Light Background + Hidden 'Most Popular' Tag that Pops on Hover) */}
            <div 
              onClick={() => handleOpenModal('Car Basic Plan - ₹2,199')}
              className="bg-slate-50 border border-slate-200 rounded-3xl p-8 flex flex-col justify-between relative shadow-sm cursor-pointer transition-all duration-300 ease-out hover:-translate-y-3 hover:shadow-2xl hover:border-blue-400 group"
            >
              {/* Tag is hidden by default (opacity-0 scale-75) and pops up on card hover */}
              <span className="absolute -top-3.5 right-6 bg-emerald-500 text-white text-xs font-black px-4 py-1 rounded-full uppercase tracking-wider shadow-md opacity-0 scale-75 translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:scale-100 group-hover:-translate-y-1">
                MOST POPULAR
              </span>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl transition-transform duration-300 group-hover:scale-125">🚗</span>
                  <h3 className="font-black text-xl text-slate-900">CAR BASIC PLAN</h3>
                </div>
                <p className="text-xs font-bold text-blue-600 uppercase">Body Wash</p>
                <span className="inline-block bg-blue-100 text-blue-800 text-xs font-extrabold px-3 py-1.5 rounded-lg my-4">
                  16 BODY WASHES + 1 FREE DEEP CLEAN
                </span>
                <p className="text-sm text-slate-600 font-semibold mb-6">4 Washes Every Week</p>

                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-4xl font-black text-slate-900">₹2,199</span>
                  <span className="text-base font-normal text-slate-400 line-through">₹2,399</span>
                  <span className="bg-yellow-400 text-slate-950 font-extrabold text-xs px-2.5 py-1 rounded-md shadow-sm">SAVE ₹200</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">Per Wash Cost: ₹137.44 (Free Deep Clean)</p>
              </div>

              <button className="mt-8 w-full bg-slate-900 group-hover:bg-blue-600 text-white font-bold text-sm py-4 rounded-2xl transition-colors">
                Select Car Basic
              </button>
            </div>

            {/* Car Pro Plan */}
            <div 
              onClick={() => handleOpenModal('Car Pro Plan - ₹2,999')}
              className="bg-slate-50 border border-slate-200 rounded-3xl p-8 flex flex-col justify-between relative shadow-sm cursor-pointer transition-all duration-300 ease-out hover:-translate-y-3 hover:shadow-2xl hover:border-blue-400 group"
            >
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl transition-transform duration-300 group-hover:scale-125">🏎️</span>
                  <h3 className="font-black text-xl text-slate-900">CAR PRO PLAN</h3>
                </div>
                <p className="text-xs font-bold text-slate-500 uppercase">Premium Care</p>
                <span className="inline-block bg-blue-100 text-blue-800 text-xs font-extrabold px-3 py-1.5 rounded-lg my-4">
                  12 BODY WASHES + 4 DEEP CLEANS
                </span>
                <p className="text-sm text-slate-600 font-semibold mb-6">3 Body + 1 Deep Clean / Week</p>

                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-4xl font-black text-slate-900">₹2,999</span>
                  <span className="text-base font-normal text-slate-400 line-through">₹3,499</span>
                  <span className="bg-yellow-400 text-slate-950 font-extrabold text-xs px-2.5 py-1 rounded-md shadow-sm">SAVE ₹500</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">Per Service Cost: ₹187.44</p>
              </div>

              <button className="mt-8 w-full bg-slate-900 group-hover:bg-blue-600 text-white font-bold text-sm py-4 rounded-2xl transition-colors">
                Select Car Pro
              </button>
            </div>

            {/* Custom Plan (Light Slate Default -> Vibrant Brand Blue on Hover) */}
            <div 
              onClick={() => handleOpenModal('Custom Plan')}
              className="bg-slate-50 border border-slate-200 rounded-3xl p-8 flex flex-col justify-between relative shadow-sm cursor-pointer transition-all duration-300 ease-out hover:bg-blue-600 hover:border-blue-600 hover:-translate-y-3 hover:shadow-2xl group"
            >
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl transition-transform duration-300 group-hover:rotate-45">⚙️</span>
                  <h3 className="font-black text-xl text-slate-900 group-hover:text-white transition-colors">CUSTOM PLAN</h3>
                </div>
                <p className="text-xs font-bold text-slate-500 group-hover:text-blue-100 uppercase transition-colors">
                  Tailored To You
                </p>
                <p className="text-sm text-slate-600 group-hover:text-white my-6 leading-relaxed transition-colors">
                  Customize your wash schedule according to your preferred days, timing, and specific detailing requirements.
                </p>
              </div>

              <button className="mt-8 w-full bg-slate-900 group-hover:bg-white group-hover:text-blue-600 text-white font-extrabold text-sm py-4 rounded-2xl transition-colors">
                Contact Us To Build Plan
              </button>
            </div>

          </div>
        </div>
      </section>

      {/* 5. Services Table (Interactive Rows) */}
      <section id="comparison" className="py-20 bg-slate-50 border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <h2 className="text-sm font-extrabold tracking-widest text-blue-600 uppercase">Feature Matrix</h2>
            <p className="text-3xl font-black text-slate-900 mt-2">Services Included</p>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-xl transition-all hover:shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-800">
                <thead className="bg-blue-900 text-white uppercase text-xs font-black tracking-wider">
                  <tr>
                    <th className="py-5 px-6">Services</th>
                    <th className="py-5 px-6 text-center">Bike Plan</th>
                    <th className="py-5 px-6 text-center">Car Basic Plan</th>
                    <th className="py-5 px-6 text-center">Car Pro Plan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {[
                    { name: '🧼 Pressure Wash', bike: '✓', basic: '✓', pro: '✓' },
                    { name: '🫧 Foam Wash', bike: '✓', basic: '✓', pro: '✓' },
                    { name: '🛞 Tire & Rim Cleaning', bike: '✓', basic: '✓', pro: '✓' },
                    { name: '🪟 Glass Cleaning', bike: '✓', basic: '✓', pro: '✓' },
                    { name: '🧹 Interior Vacuum', bike: '—', basic: '1 TIME / MONTH', pro: '4 TIMES / MONTH' },
                    { name: '✨ Dashboard & Panel Cleaning', bike: '—', basic: '✓', pro: '✓' },
                    { name: '🧽 Deep Cleaning (Interior + Exterior)', bike: '—', basic: '1 TIME / MONTH', pro: '4 TIMES / MONTH' },
                    { name: '📸 Before & After Photos', bike: '✓', basic: '✓', pro: '✓' }
                  ].map((row, i) => (
                    <tr key={i} className="hover:bg-blue-50/60 transition-colors cursor-pointer">
                      <td className="py-4 px-6 font-bold text-slate-900">{row.name}</td>
                      <td className={`py-4 px-6 text-center font-extrabold ${row.bike === '✓' ? 'text-emerald-600 text-lg' : 'text-slate-300'}`}>{row.bike}</td>
                      <td className={`py-4 px-6 text-center font-extrabold ${row.basic === '✓' ? 'text-emerald-600 text-lg' : row.basic === '—' ? 'text-slate-300' : 'text-blue-700'}`}>{row.basic}</td>
                      <td className={`py-4 px-6 text-center font-extrabold ${row.pro === '✓' ? 'text-emerald-600 text-lg' : row.pro === '—' ? 'text-slate-300' : 'text-blue-700'}`}>{row.pro}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Subscribe. Relax. Repeat. Section (Interactive Cards) */}
      <section className="py-20 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h3 className="text-3xl font-black text-slate-900 uppercase">SUBSCRIBE. RELAX. REPEAT.</h3>
            <p className="text-sm font-medium text-slate-600 mt-2">We take care of the rest, so you can enjoy a cleaner, happier ride every single day!</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { icon: '👌', title: 'Hassle Free', desc: 'No more calling washers or waiting in long queues.' },
              { icon: '💳', title: 'Affordable', desc: 'Save up to ₹500 with our weekly & monthly plans.' },
              { icon: '📍', title: 'Convenient', desc: 'We come to you, directly inside your society parking.' },
              { icon: '🛡️', title: 'Reliable', desc: 'Consistent quality and dedicated morning slots.' }
            ].map((item, idx) => (
              <div 
                key={idx} 
                className="bg-slate-50 p-6 rounded-2xl border border-slate-200 text-center shadow-sm cursor-pointer transition-all duration-300 hover:-translate-y-2 hover:shadow-xl hover:border-blue-400 group"
              >
                <span className="text-3xl inline-block transition-transform duration-300 group-hover:scale-125">{item.icon}</span>
                <h4 className="font-bold text-slate-900 text-base mt-3 group-hover:text-blue-600 transition-colors">{item.title}</h4>
                <p className="text-xs text-slate-500 mt-1">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 7. Footer */}
      <footer id="contact" className="bg-blue-950 text-white py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex items-center gap-4">
            <span className="text-4xl font-black italic tracking-wider text-white">WASHO</span>
            <span className="text-sm text-blue-300 border-l border-blue-800 pl-4">Doorstep Care • Kharadi</span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-8 text-sm font-bold">
            <a href="tel:8668890147" className="hover:text-yellow-400 transition-colors">
              📞 8668890147 / 9822911523
            </a>
            <a href="mailto:contact.washo@gmail.com" className="hover:text-yellow-400 transition-colors">
              ✉️ contact.washo@gmail.com
            </a>
            <span className="text-blue-300">📍 Kharadi, Pune</span>
          </div>

          <p className="text-xs text-blue-400">© 2026 WASHO. All rights reserved.</p>
        </div>
      </footer>

      {/* Booking Modal */}
      <FreeWashModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
}