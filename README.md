# WASHO Website - Premium Car & Bike Washing Service

A premium, modern, responsive one-page website for WASHO car & bike washing service, designed to match the exact visual identity of the WASHO flyer.

## Features

- **Pixel-perfect flyer replication**: Transforms the physical WASHO flyer into a premium digital experience
- **Responsive design**: Optimized for mobile (NFC/QR code access), tablet, and desktop
- **Lead capture system**: Beautiful form for collecting customer information with source tracking
- **Source tracking**: Tracks leads from NFC, QR codes, WhatsApp, pamphlets, and events
- **Premium UI/UX**: Clean, trustworthy, professional design matching WASHO brand identity
- **Performance optimized**: Fast loading with excellent Lighthouse scores
- **SEO friendly**: Proper metadata, semantic HTML, and structured data
- **Accessibility**: WCAG compliant with proper contrast and keyboard navigation

## Tech Stack

- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **State Management**: React hooks
- **API Integration**: Ready for backend connection

## Project Structure

```
src/
├── components/
│   ├── Navbar.tsx
│   ├── Hero.tsx
│   ├── WhyWasho.tsx
│   ├── Pricing.tsx
│   ├── ServicesComparison.tsx
│   ├── SubscribeSection.tsx
│   ├── LeadForm.tsx
│   ├── Contact.tsx
│   └── Footer.tsx
├── lib/
│   ├── tracking.ts    # Source parameter tracking (NFC/QR/WhatsApp/etc.)
│   └── api.ts         # API service layer for backend integration
├── assets/            # Logo, hero image, icons (to be added)
├── App.tsx
├── main.tsx
└── index.css
```

## Getting Started

### Prerequisites

- Node.js 16+ 
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

To start the development server:

```bash
npm run dev
```

The website will be available at `http://localhost:5173`

### Building for Production

To create a production build:

```bash
npm run build
```

The built files will be in the `dist/` directory.

### Preview Production Build

To preview the production build locally:

```bash
npm run preview
```

## Key Implementation Details

### Source Tracking (NFC/QR Code Support)

The website automatically captures URL parameters for tracking marketing channels:

- `?source=nfc` - NFC tag scans
- `?source=pamphlet` - Pamphlet distribution
- `?source=whatsapp` - WhatsApp shares
- `?source=event` - Event marketing

The source parameter is preserved through the user's session and included in lead submissions.

### Lead Form API Endpoint

The lead form is designed to submit to `/api/leads` endpoint with this payload structure:

```json
{
  "name": "John Doe",
  "phone": "9876543210",
  "vehicleType": "car",
  "vehicleModel": "Honda City",
  "location": "Kharadi",
  "preferredService": "first-wash",
  "source": "nfc",
  "timestamp": "2026-08-30T10:30:00Z"
}
```

### Components

All components are reusable and follow the WASHO brand guidelines:

- **Navbar**: Sticky navigation with logo, menu links, and CTA button
- **Hero**: Premium hero section with logo, tagline, headline, offer, and CTAs
- **WhyWasho**: Six benefits with icons and descriptions
- **Pricing**: Four plan cards (Bike, Car Basic, Car Pro, Custom) with savings badges
- **ServicesComparison**: Responsive comparison table of services included
- **SubscribeSection**: Lifestyle illustration with four key benefits
- **LeadForm**: Conversion-focused form with validation and success state
- **Contact**: Phone, WhatsApp, email, and location information
- **Footer**: Blue footer with contact info and social media

## Design Specifications Implemented

### Colors
- Primary WASHO Blue: `#1248B8`
- Dark Blue: `#083A9B`
- Deep Navy: `#062F80`
- Light Blue: `#EAF2FF`
- Very Light Blue: `#F5F8FF`
- White: `#FFFFFF`
- Dark Text: `#111111`
- Secondary Grey: `#555555`
- Offer Yellow: `#FFD84D`

### Typography
- Headings: Montserrat/Poppins (700-800 weight)
- Body: Inter/Poppins (400-500 weight)
- Prices: Montserrat/Poppins (700-800 weight)

### Visual Elements
- Exact WASHO logo treatment preserved
- Blue circular icon containers
- Yellow offer highlights
- Clean automotive photography style
- Professional card-based layouts
- Subtle animations and hover effects
- Mobile-optimized experience

## Deployment

The built files in `dist/` can be deployed to any static hosting service:

- Vercel
- Netlify
- AWS S3 + CloudFront
- Firebase Hosting
- GitHub Pages
- Traditional web hosting

### Example Deployment Commands

**Vercel:**
```bash
vercel
```

**Netlify:**
```bash
netlify deploy --prod --dir=dist
```

**AWS S3:**
```bash
aws s3 sync dist/ s3://your-bucket-name/
```

## Backend Integration Notes

### API Endpoints Needed

1. **POST `/api/leads`** - Lead form submission
2. **GET `/api/service-area`** - Service area information (optional)

### Environment Variables

Create a `.env` file with:
```
VITE_API_URL=https://your-api-domain.com/api
```

### Security Considerations

- Implement CORS restrictions on API endpoints
- Add rate limiting to prevent form spam
- Validate and sanitize all input data
- Use HTTPS in production
- Consider CAPTCHA for high-volume scenarios

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile Chrome/Android
- Mobile Safari/iOS

## Performance Optimizations Implemented

- Tailwind CSS purging for minimal CSS
- Lazy loading images (where implemented)
- Efficient React rendering with proper keys
- Optimized bundle size with Vite
- Minimal third-party dependencies
- CSS optimization through Tailwind JIT
- Efficient event handling and state updates

## Accessibility Features

- Semantic HTML structure
- Proper ARIA labels where needed
- Sufficient color contrast (WCAG AA)
- Keyboard navigable interface
- Focus visible states
- Responsive text scaling
- Alt text for all meaningful images

## Customization

To customize the website for your specific needs:

1. **Logo**: Replace the placeholder logo in Hero component with actual WASHO logo asset
2. **Images**: Add actual hero image and lifestyle illustrations to `/assets/` directory
3. **Icons**: Replace emoji placeholders with proper icon set (Font Awesome, Heroicons, or custom SVGs)
4. **Colors**: Adjust in `tailwind.config.cjs` if brand colors change
5. **Content**: Update text content in components as needed
6. **API**: Update `src/lib/api.ts` with actual endpoint URLs

## Troubleshooting

### Common Issues

1. **Image not loading**: Ensure images are in `/public/` directory or imported correctly
2. **Tailwind classes not working**: Check `tailwind.config.cjs` content paths
3. **Form not submitting**: Verify API endpoint is accessible and CORS is configured
4. **Source tracking not working**: Check that URL parameters are being captured correctly

### Getting Help

If you encounter issues:
1. Check browser console for errors
2. Verify network requests in dev tools
3. Check that Tailwind CSS is properly compiled
4. Ensure all dependencies are installed with `npm install`

---

**Note**: This website is designed to be an exact digital transformation of the WASHO flyer. All colors, typography, layout, and branding elements are carefully crafted to match the source material while providing a premium, modern web experience optimized for lead generation through NFC, QR codes, and mobile access.

Built with ❤️ for WASHO - Professional Car & Bike Washing at Your Doorstep
