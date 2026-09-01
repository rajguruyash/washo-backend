
const Footer = () => {
  return (
    <footer className="bg-washo-dark">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col items-center md:flex-row md:justify-between md:items-start gap-6">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <span className="text-washo-blue font-heading font-bold text-2xl italic">WASHO</span>
          </div>

          {/* Contact Info */}
          <div className="text-center md:text-left space-y-4">
            <div className="flex items-center space-x-3">
              <span className="h-4 w-4 text-washo-blue">📱</span>
              <a href="tel:8668890147" className="text-washo-light hover:text-washo-blue transition-colors duration-200">
                8668890147
              </a>
            </div>
            <div className="flex items-center space-x-3">
              <span className="h-4 w-4 text-washo-blue">📧</span>
              <a href="mailto:contact.washo@gmail.com" className="text-washo-light hover:text-washo-blue transition-colors duration-200">
                contact.washo@gmail.com
              </a>
            </div>
          </div>

          {/* Social Media */}
          <div className="flex space-x-4 text-washo-light">
            <span className="h-5 w-5">📸</span>
            <span className="h-5 w-5">📘</span>
            <span className="h-5 w-5">🐦</span>
          </div>
        </div>

        <div className="mt-8 text-center text-washo-light/50 text-sm">
          © 2026 WASHO. All rights reserved.
        </div>
      </div>
    </footer>
  );
};

export default Footer;