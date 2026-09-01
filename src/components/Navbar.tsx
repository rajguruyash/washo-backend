import { useState } from 'react';

interface NavbarProps {
  onClaimFreeWash: () => void;
}

const Navbar = ({ onClaimFreeWash }: NavbarProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="bg-white border-b border-washo-light/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex h-16 items-center justify-between">
        <div className="flex items-center gap-3">
          {/* WASHO Logo - will be replaced with actual logo asset */}
          <a href="#" className="flex items-center">
            <span className="text-washo-blue font-heading font-bold text-2xl italic">WASHO</span>
          </a>
        </div>

        <div className="hidden md:flex md:items-center md:space-x-6">
          <a href="#why" className="text-washo-dark hover:text-washo-blue transition-colors duration-200 px-3 py-2 rounded-md hover:bg-washo-lightest">Why WASHO</a>
          <a href="#plans" className="text-washo-dark hover:text-washo-blue transition-colors duration-200 px-3 py-2 rounded-md hover:bg-washo-lightest">Plans</a>
          <a href="#contact" className="text-washo-dark hover:text-washo-blue transition-colors duration-200 px-3 py-2 rounded-md hover:bg-washo-lightest">Contact</a>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-outline md:hidden" onClick={() => setIsOpen(!isOpen)}>
            Menu
          </button>
          {/* Persistent Free Wash CTA */}
          <button onClick={onClaimFreeWash} className="btn-primary hidden md:inline-flex">
            CLAIM FREE WASH
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      <div className={`md:hidden ${isOpen ? 'block' : 'hidden'}`}>
        <div className="px-2 pt-2 pb-3 space-y-1">
          <a href="#why" className="block px-3 py-2 rounded-md text-base font-medium text-washo-dark hover:bg-washo-lightest hover:text-washo-blue">Why WASHO</a>
          <a href="#plans" className="block px-3 py-2 rounded-md text-base font-medium text-washo-dark hover:bg-washo-lightest hover:text-washo-blue">Plans</a>
          <a href="#contact" className="block px-3 py-2 rounded-md text-base font-medium text-washo-dark hover:bg-washo-lightest hover:text-washo-blue">Contact</a>
        </div>
        <div className="px-2 pt-2 pb-3">
          {/* Persistent Free Wash CTA for mobile */}
          <button onClick={onClaimFreeWash} className="block w-full text-center px-3 py-2 rounded-md bg-washo-blue text-white font-medium hover:bg-washo-dark hover:shadow-md">
            CLAIM FREE WASH
          </button>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
