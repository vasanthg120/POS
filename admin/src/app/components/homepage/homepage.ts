import { Component, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

interface Card  { icon: SafeHtml; title: string; desc: string; }
interface Ind   { icon: SafeHtml; name: string; }

@Component({
  selector: 'app-homepage',
  imports: [CommonModule, RouterModule],
  templateUrl: './homepage.html',
  styleUrl: './homepage.css',
})
export class Homepage implements OnInit {
  isScrolled = false;
  menuOpen   = false;

  heroCards:     Card[]  = [];
  services:      Card[]  = [];
  aboutFeatures: Card[]  = [];
  industries:    Ind[]   = [];

  processSteps = [
    { num: '01', title: 'Share Your Brief',   desc: 'Tell us your product, quantity, deadline, and budget via our quote form or call.' },
    { num: '02', title: 'Artwork & Design',   desc: 'Our design team prepares print-ready artwork or refines your existing files.' },
    { num: '03', title: 'Approval & Payment', desc: 'Review and approve the digital proof, then confirm your order online securely.' },
    { num: '04', title: 'Production',         desc: 'Your order goes into production printed, embroidered, or assembled to spec.' },
    { num: '05', title: 'Delivery',           desc: 'Packaged and branded.' }
  ];

  constructor(private san: DomSanitizer) {}

  // Sanitize SVG string so Angular's [innerHTML] doesn't strip it
  private s(raw: string): SafeHtml {
    return this.san.bypassSecurityTrustHtml(raw);
  }

  ngOnInit(): void {

    this.heroCards = [
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M3 7l5-3h8l5 3-4 3v8H7V10L3 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 5c0 1.3 1.1 2.4 2.4 2.4S11.8 6.3 11.8 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`), title: 'Custom Apparel',  desc: 'T-shirts, polos, hoodies with your brand' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><rect x="3" y="9" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h18M12 9V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),                                                                                                                                                               title: 'Corporate Gifts', desc: 'Premium branded gifts for clients & teams' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><rect x="5" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15H3v6h18v-6h-2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 19h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),                                                                             title: 'Screen Printing', desc: 'Vibrant prints at scale, any quantity' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><rect x="3" y="5" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M11 16v4M8 20h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M19 8l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),                                                  title: 'Signage & Print', desc: 'Banners, standees, event displays' }
    ];

    this.services = [
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M3 7l5-3h8l5 3-4 3v8H7V10L3 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 5c0 1.3 1 2.4 2.3 2.4S11.5 6.3 11.5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`),                                                                                                                         title: 'Custom Apparel',    desc: 'Branded T-shirts, polos, hoodies, uniforms, and workwear for teams of all sizes.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><rect x="3" y="9" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h18M12 9V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 9C12 9 8.5 5.5 8.5 4a3 3 0 0 1 3.5 2M12 9C12 9 15.5 5.5 15.5 4a3 3 0 0 0-3.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`), title: 'Corporate Gifts',   desc: 'Curated branded merchandise packs diaries, pens, mugs, power banks for clients, employees, and events.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><rect x="5" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15H3v6h18v-6h-2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 19h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),                                                                             title: 'Screen Printing',  desc: 'High-volume, vibrant screen printing on garments, bags, and hard goods with spot-on colour accuracy.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M12 3c2 0 3.5 1.5 3.5 3.5 0 1.5-1 2.8-2.4 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20l3-7h10l3 7H4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="9" r="1" fill="currentColor"/></svg>`),                                                                             title: 'Embroidery',       desc: 'Precision logo embroidery on caps, jackets, and premium corporate wear crisp, durable, professional.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><rect x="3" y="5" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M11 16v4M8 20h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M19 8l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),                                                  title: 'Signage & Displays',desc: 'Roll-up banners, flex boards, standees, pop-ups, and vehicle wraps for events, offices, and retail.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`),                                                                                                                                                                                               title: 'Promo Products',   desc: 'Thousands of branded promotional items from pens to tech gadgets sourced, branded, and shipped for your next campaign.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><rect x="2" y="7" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M2 11h20M8 7V5a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),                                                                                                                                                   title: 'Bags & Accessories',desc: 'Custom tote bags, backpacks, laptop sleeves, and lanyards branded to your spec for retail, trade shows, or gifting.' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M4 4h16v4H4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 12h7M4 16h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M14 12l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),                                                   title: 'Design & Artwork',  desc: 'In-house design team to create, refine, and prepare print-ready artwork free with qualifying orders.' }
    ];

    this.aboutFeatures = [
      { icon: this.s(`<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M10 2L3 5.5v4.5c0 4 2.8 7.4 7 8.4 4.2-1 7-4.4 7-8.4V5.5L10 2z" stroke="currentColor" stroke-width="1.5"/><path d="M7 10l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`), title: 'Global Franchise, Local Expertise',         desc: "Backed by Fully Promoted's worldwide network, with a team that understands Chennai's unique business culture." },
      { icon: this.s(`<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),                                                                                                                                                         title: 'Fast Turnaround',                           desc: 'Standard orders in 7–10 days. Rush 48-hour production available for urgent campaigns and last-minute events.' },
      { icon: this.s(`<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M4 10h12M10 4l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),                                                                                                                                                                                                                       title: 'No Minimum Too Small, No Order Too Large', desc: 'From 10-piece sample packs to 50,000-unit campaigns we scale with your needs and budget.' }
    ];

    this.industries = [
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`), name: 'Technology' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 22V12h6v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`), name: 'Real Estate' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="1.6"/><path d="M16 3H8L6 7h12l-2-4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`), name: 'Hospitality' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`), name: 'Healthcare' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10z" stroke="currentColor" stroke-width="1.6"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="1.4"/></svg>`), name: 'Education' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`), name: 'Retail' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`), name: 'Corporates' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`), name: 'Events & Expos' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/><path d="M8.56 2.75c4.37 6.03 6.02 9.42 8.03 17.72m2.54-15.38c-3.72 4.35-8.94 5.66-16.88 5.85m19.5 1.9c-3.5-.93-6.63-.82-8.94 0-2.58.92-5.01 2.86-7.44 6.32" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`), name: 'NGOs & CSR' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`), name: 'Manufacturing' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`), name: 'BFSI' },
      { icon: this.s(`<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`), name: 'Social Campaigns' }
    ];
  }

  @HostListener('window:scroll')
  onScroll(): void {
    this.isScrolled = window.scrollY > 20;
  }

  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    this.menuOpen = false;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
  }
}
