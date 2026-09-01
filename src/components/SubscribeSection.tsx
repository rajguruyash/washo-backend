const SubscribeSection = () => {
  return (
    <section className="py-16 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="section-heading">
          SUBSCRIBE. RELAX. REPEAT.
        </h2>
        
        <div className="mt-10 text-washo-dark text-center text-lg max-w-2xl mx-auto">
          We take care of the rest,
          so you can enjoy a cleaner,
          happier ride – every day!
        </div>
        
        <div className="mt-12 flex flex-col lg:flex-row lg:items-center lg:justify-center gap-8">
          {/* Illustration placeholder */}
          <div className="lg:w-1/2 flex items-center justify-center">
            <div className="relative aspect-w-16 aspect-h-9 bg-washo-light rounded-xl overflow-hidden shadow-lg">
              {/* Placeholder for lifestyle illustration */}
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-washo-light/50 to-white">
                <div className="text-center">
                  <div className="mb-6">
                    {/* Person relaxing */}
                    <div className="w-24 h-24 bg-washo-blue rounded-full flex items-center justify-center">
                      <span className="text-white text-xl">😌</span>
                    </div>
                    {/* Vehicle */}
                    <div className="w-32 h-16 bg-white rounded-xl shadow-md mt-4"></div>
                  </div>
                  <p className="text-washo-dark text-sm max-w-md">
                    Premium vehicle care service<br/>
                    Hassle-free subscription model
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          {/* Benefits */}
          <div className="space-y-6 lg:w-1/2">
            <div className="flex items-start gap-4">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-light rounded-full shrink-0">
                <span className="text-washo-blue text-xl">👍</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg uppercase mb-2">
                  HASSLE FREE
                </h3>
                <p className="text-washo-dark">
                  No more calling washers or waiting<br/>
                  in queues.
                </p>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-6">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-light rounded-full shrink-0">
                <span className="text-washo-blue text-xl">💰</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg uppercase mb-2">
                  AFFORDABLE
                </h3>
                <p className="text-washo-dark">
                  Save more with our<br/>
                  weekly & monthly plans.
                </p>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-6">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-light rounded-full shrink-0">
                <span className="text-washo-blue text-xl">📍</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg uppercase mb-2">
                  CONVENIENT
                </h3>
                <p className="text-washo-dark">
                  We come to you,<br/>
                  right in your parking space.
                </p>
              </div>
            </div>
            
            <div className="flex items-start gap-4 mt-6">
              <div className="flex items-center justify-center w-10 h-10 bg-washo-light rounded-full shrink-0">
                <span className="text-washo-blue text-xl">🛡️</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-lg uppercase mb-2">
                  RELIABLE
                </h3>
                <p className="text-washo-dark">
                  Consistent service<br/>
                  you can count on every time.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SubscribeSection;
