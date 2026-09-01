const Contact = () => {
  return (
    <section id="contact" className="py-16 bg-washo-lightest">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="section-heading text-center">
          CONTACT US
        </h2>
        
        <div className="mt-8 flex flex-col lg:flex-row lg:justify-between lg:items-center gap-6">
          {/* Contact Info */}
          <div className="space-y-3 lg:w-1/2">
            <div className="flex items-start gap-4">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-blue rounded-full shrink-0">
                <span className="text-white text-xl">📱</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg mb-2">
                  CALL NOW
                </h3>
                <div className="space-y-1">
                  <a href="tel:8668890147" className="block text-washo-dark hover:text-washo-blue transition-colors duration-200 font-medium">
                    8668890147
                  </a>
                  <a href="tel:9822911523" className="block text-washo-dark hover:text-washo-blue transition-colors duration-200 font-medium">
                    9822911523
                  </a>
                </div>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-4">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-blue rounded-full shrink-0">
                <span className="text-white text-xl">💬</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg mb-2">
                  WHATSAPP US
                </h3>
                <p className="text-washo-dark">
                  Join our WhatsApp community for updates and offers
                </p>
                <a href="https://wa.me/918668890147" target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-washo-blue font-medium hover:text-washo-dark transition-colors duration-200">
                  Click to Chat on WhatsApp
                </a>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-4">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-blue rounded-full shrink-0">
                <span className="text-white text-xl">📧</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg mb-2">
                  EMAIL US
                </h3>
                <a href="mailto:contact.washo@gmail.com" className="block text-washo-dark hover:text-washo-blue transition-colors duration-200 font-medium">
                  contact.washo@gmail.com
                </a>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-4">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-blue rounded-full shrink-0">
                <span className="text-white text-xl">📍</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg mb-2">
                  LOCATION
                </h3>
                <p className="text-washo-dark">
                  Kharadi
                </p>
                {/* In a real app, this might link to maps */}
                <a href="https://maps.google.com/?q=Kharadi" target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-washo-blue font-medium hover:text-washo-dark transition-colors duration-200">
                  View on Map
                </a>
              </div>
            </div>
          </div>
          
          {/* Map or illustration placeholder */}
          <div className="lg:w-1/2 flex items-center justify-center hidden lg:block">
            <div className="relative aspect-w-16 aspect-h-9 bg-washo-light rounded-xl overflow-hidden shadow-lg">
              {/* Placeholder for map or service area illustration */}
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-washo-light/50 to-white">
                <div className="text-center">
                  <div className="mb-4">
                    {/* Map pin */}
                    <div className="w-16 h-16 bg-washo-blue rounded-full flex items-center justify-center">
                      <span className="text-white text-xl">📍</span>
                    </div>
                    {/* Service area */}
                    <div className="w-32 h-20 bg-white rounded-xl shadow-md mt-4"></div>
                  </div>
                  <p className="text-washo-dark text-sm max-w-md">
                    Serving Kharadi and surrounding areas<br/>
                    Doorstep vehicle washing service
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Contact;
