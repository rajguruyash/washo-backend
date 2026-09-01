const ServicesComparison = () => {
  const services = [
    { name: "Pressure Wash", bike: true, carBasic: true, carPro: true },
    { name: "Foam Wash", bike: true, carBasic: true, carPro: true },
    { name: "Tire & Rim Cleaning", bike: true, carBasic: true, carPro: true },
    { name: "Glass Cleaning", bike: true, carBasic: true, carPro: true },
    { name: "Interior Vacuum", bike: false, carBasic: true, carPro: true, note: "(Once a Month)" },
    { name: "Dashboard & Panel Cleaning", bike: false, carBasic: true, carPro: true },
    { name: "Deep Cleaning (Interior + Exterior)", bike: false, carBasic: true, carPro: true },
    { name: "Before & After Photos", bike: true, carBasic: true, carPro: true }
  ];

  return (
    <section className="py-16 bg-washo-lightest">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="section-heading">
          SERVICES INCLUDED
        </h2>
        
        <div className="table-responsive">
          <table className="service-table">
            <thead>
              <tr>
                <th className="w-1/3">SERVICE</th>
                <th>BIKE PLAN</th>
                <th>CAR BASIC PLAN</th>
                <th>CAR PRO PLAN</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service, index) => (
                <tr key={index}>
                  <td className="font-medium text-washo-dark">
                    {service.name}
                    {service.note && (
                      <>
                        <br />
                        <span className="text-washo-dark text-sm block">{service.note}</span>
                      </>
                    )}
                  </td>
                  <td className="text-center">
                    <div className="service-check">
                      {service.bike ? (
                        <div className="service-check-icon">✓</div>
                      ) : (
                        <div className="service-check-icon">-</div>
                      )}
                      <span className="service-check-text">{service.bike ? "Included" : "Not Included"}</span>
                    </div>
                  </td>
                  <td className="text-center">
                    <div className="service-check">
                      {service.carBasic ? (
                        <div className="service-check-icon">✓</div>
                      ) : (
                        <div className="service-check-icon">-</div>
                      )}
                      <span className="service-check-text">{service.carBasic ? "Included" : "Not Included"}</span>
                    </div>
                  </td>
                  <td className="text-center">
                    <div className="service-check">
                      {service.carPro ? (
                        <div className="service-check-icon">✓</div>
                      ) : (
                        <div className="service-check-icon">-</div>
                      )}
                      <span className="service-check-text">{service.carPro ? "Included" : "Not Included"}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {/* Mobile view - cards */}
        <div className="mt-8 hidden lg:block">
          <p className="text-washo-dark text-center text-lg">
            On mobile devices, this table becomes horizontally scrollable for easy viewing.
          </p>
        </div>
      </div>
    </section>
  );
};

export default ServicesComparison;
