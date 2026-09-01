const Pricing = () => {
  const plans = [
    {
      id: 1,
      title: "BIKE PLAN",
      subtitle: "STANDARD WASH",
      icon: "motorcycle",
      infoBar: "16 WASHES / MONTH",
      infoBarBottom: "4 WASHES EVERY WEEK",
      price: "₹999",
      pricePeriod: "/ month",
      originalPrice: "₹1,199",
      savings: "SAVE ₹200",
      perCost: "Per Wash Cost: ₹62.44",
      isPopular: false
    },
    {
      id: 2,
      title: "CAR BASIC PLAN",
      subtitle: "BODY WASH",
      icon: "car",
      infoBar: "16 BODY WASHES\n+ 4 DEEP CLEAN",
      infoBarBottom: "4 WASHES EVERY WEEK",
      price: "₹2,199",
      pricePeriod: "/ month",
      originalPrice: "₹2,399",
      savings: "SAVE ₹200",
      perCost: "Per Wash Cost: ₹137.44",
      note: "(Free 1 Deep Clean Included)",
      isPopular: true
    },
    {
      id: 3,
      title: "CAR PRO PLAN",
      subtitle: "PREMIUM CARE",
      icon: "car",
      infoBar: "12 BODY WASHES\n+ 4 DEEP CLEANS",
      infoBarBottom: "3 WASHES + 1 PREMIUM WASH\nEVERY WEEK",
      price: "₹2,999",
      pricePeriod: "/ month",
      originalPrice: "₹3,499",
      savings: "SAVE ₹500",
      perCost: "Per Service Cost: ₹187.44",
      note: "(12 Body Washes + 4 Deep Cleans)",
      isPopular: false
    },
    {
      id: 4,
      title: "CUSTOM PLAN",
      subtitle: "DESIGNED FOR YOU",
      icon: "sliders",
      infoBar: "",
      infoBarBottom: "",
      price: "",
      pricePeriod: "",
      originalPrice: "",
      savings: "",
      perCost: "",
      note: "Plans made according to your preferred days,\ntime & service needs.",
      ctaText: "CONTACT US",
      isPopular: false
    }
  ];

  return (
    <section id="plans" className="py-16 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="section-heading">
          CHOOSE THE PLAN THAT SUITS YOU BEST
        </h2>
        
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map(plan => (
            <div key={plan.id} className="card hover-lift hover-shadow">
              {plan.isPopular && (
                <div className="absolute -top-2 right-2 bg-green-600 text-white text-xs px-2 py-1 rounded">
                  POPULAR
                </div>
              )}
              <div className="relative">
                <div className="card-header">
                  {/* Icon placeholder */}
                  <div className="icon-container">
                    <div className="text-washo-blue text-2xl">
                      {plan.icon === "motorcycle" && "🏍️"}
                      {plan.icon === "car" && "🚗"}
                      {plan.icon === "sliders" && "⚙️"}
                    </div>
                  </div>
                  <div>
                    <h3 className="card-title">{plan.title}</h3>
                    <p className="card-subtitle">{plan.subtitle}</p>
                  </div>
                </div>
                
                {plan.infoBar && (
                  <div className="bg-washo-light/50 w-fit px-3 py-1 rounded mb-4 text-washo-blue font-medium text-sm">
                    {plan.infoBar}
                  </div>
                )}
                
                {plan.infoBarBottom && (
                  <p className="text-washo-dark text-center mb-4">{plan.infoBarBottom}</p>
                )}
                
                {plan.price && (
                  <>
                    <div className="card-price flex items-baseline gap-2">
                      <span>{plan.price}</span>
                      <span className="text-sm">{plan.pricePeriod}</span>
                    </div>
                    
                    {plan.originalPrice && (
                      <div className="flex justify-center mt-2">
                        <span className="card-original-price">{plan.originalPrice}</span>
                        <span className="ml-2 card-savings-badge">{plan.savings}</span>
                      </div>
                    )}
                    
                    {plan.perCost && (
                      <p className="text-washo-dark text-center mt-4">{plan.perCost}</p>
                    )}
                    
                    {plan.note && (
                      <p className="card-note text-center">{plan.note}</p>
                    )}
                    
                    {plan.ctaText && (
                      <button
                        className="btn-outline w-full mt-6"
                        onClick={() => {
                          window.location.hash = '#contact';
                        }}
                      >
                        {plan.ctaText}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Pricing;
