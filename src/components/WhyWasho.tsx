const WhyWasho = () => {
  const benefits = [
    {
      id: 1,
      title: "DOORSTEP SERVICE",
      description: "We come to you.\nNo travel, no hassle.",
      icon: "home" // Would be replaced with actual icon
    },
    {
      id: 2,
      title: "NO WAITING",
      description: "No queues,\nno crowds.\nJust you.",
      icon: "users" // Would be replaced with actual icon
    },
    {
      id: 3,
      title: "ECO-FRIENDLY PRODUCTS",
      description: "Safe for your vehicle\nand the environment.",
      icon: "leaf" // Would be replaced with actual icon
    },
    {
      id: 4,
      title: "SAFE FOR PAINT & PARTS",
      description: "Gentle care for a\nlonger shine.",
      icon: "shield" // Would be replaced with actual icon
    },
    {
      id: 5,
      title: "TRAINED & VERIFIED STAFF",
      description: "Skilled professionals\nyou can trust.",
      icon: "user" // Would be replaced with actual icon
    },
    {
      id: 6,
      title: "CONVENIENT & RELIABLE",
      description: "We come to you, right in your parking space.\nConsistent service you can count on every time.",
      icon: "location" // Would be replaced with actual icon (we'll use a map pin)
    }
  ];

  return (
    <section id="why" className="bg-washo-lightest">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h2 className="section-heading">
          WHY CHOOSE WASHO?
        </h2>

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-6">
          {benefits.map(benefit => (
            <div key={benefit.id} className="text-center">
              <div className="icon-container mb-2">
                {/* Icon placeholder - would be replaced with actual icons */}
                <div className="text-washo-blue text-2xl">
                  {benefit.icon === "home" && "🏠"}
                  {benefit.icon === "users" && "👥"}
                  {benefit.icon === "droplet" && "💧"}
                  {benefit.icon === "leaf" && "🌿"}
                  {benefit.icon === "shield" && "🛡️"}
                  {benefit.icon === "user" && "👤"}
                  {benefit.icon === "location" && "📍"}
                </div>
              </div>
              <h3 className="font-heading font-bold text-washo-blue text-lg uppercase mb-2">
                {benefit.title}
              </h3>
              <p className="text-washo-dark text-center leading-relaxed">
                {benefit.description.split('\n').map((line, index) => (
                  <div key={index} className="block">{line}</div>
                ))}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default WhyWasho;
