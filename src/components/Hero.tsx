type HeroProps = {
  onClaimFreeWash: () => void;
};

const Hero = ({ onClaimFreeWash }: HeroProps) => {
  return (
    <section className="pt-16 pb-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
          {/* Left side - Text content */}
          <div className="space-y-6">
            {/* WASHO Logo - placeholder */}
            <div className="flex items-center gap-3">
              <div className="relative w-16 h-16">
                {/* Logo would go here - using placeholder for now */}
                <div className="relative w-full h-full">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-washo-blue font-heading font-bold text-2xl italic">WASHO</span>
                  </div>
                  {/* Water droplet effect around O */}
                  <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-8 h-8 bg-white rounded-full border-2 border-washo-blue"></div>
                  <div className="absolute -bottom-4 left-1/2 transform -translate-x-1/2 w-4 h-4 bg-washo-blue rounded-full"></div>
                  <div className="absolute -bottom-6 right-1/2 transform translate-x-1/2 w-3 h-3 bg-washo-blue rounded-full"></div>
                  <div className="absolute -bottom-3 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-washo-blue rounded-full"></div>
                </div>
              </div>
            </div>
            
            {/* Tagline */}
            <h2 className="text-washo-blue font-heading font-bold text-2xl uppercase tracking-wider">
              CLEAN TODAY, SHINE EVERYDAY.
            </h2>
            
            {/* Main Headline */}
            <div className="text-4xl font-heading font-bold text-dark">
              <div className="block">CLEAN VEHICLES.</div>
              <div className="block text-washo-blue">HAPPY YOU.</div>
            </div>
            
            {/* Description */}
            <p className="text-washo-dark text-lg">
              Professional car & bike washing at your doorstep.
            </p>
            
            {/* First Wash Free Offer */}
            <div className="bg-offer rounded-xl p-6 flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 bg-washo-blue rounded-full">
                {/* Gift icon placeholder */}
                <span className="text-white text-xl">🎁</span>
              </div>
              <div>
                <h3 className="font-heading font-bold text-washo-blue text-xl">
                  FIRST WASH FREE!
                </h3>
                <p className="text-washo-dark">
                  Experience WASHO with your first wash absolutely free.
                </p>
              </div>
            </div>
            
            {/* CTAs */}
            <div className="flex flex-col sm:flex-row sm:gap-4">
              <button onClick={onClaimFreeWash} className="btn-primary w-full sm:w-auto flex-1">
                CLAIM YOUR FREE WASH
              </button>
              <a href="#plans" className="btn-outline w-full sm:w-auto flex-1">
                VIEW PLANS
              </a>
            </div>
          </div>
          
          {/* Right side - Hero Image */}
          <div className="hidden lg:block">
            <div className="relative aspect-w-16 aspect-h-9 bg-washo-light rounded-xl overflow-hidden shadow-lg">
              {/* Placeholder for hero image - would be replaced with actual image */}
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-washo-light/50 to-white">
                <div className="text-center">
                  <div className="mb-4">
                    {/* Car placeholder */}
                    <div className="w-24 h-12 bg-white rounded-xl shadow-md mb-2"></div>
                    {/* Bike placeholder */}
                    <div className="w-16 h-8 bg-white rounded-md shadow-md mb-2"></div>
                  </div>
                  <p className="text-washo-dark text-lg max-w-md">
                    Premium car & bike washing at your doorstep<br/>
                    Professional foam wash service
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

export default Hero;
