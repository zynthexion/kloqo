
'use client';

import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import type { SignUpFormData } from '@/app/(public)/signup/page';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format, parse } from 'date-fns';

const plans = [
    { name: 'Kloqo Lite', price: '₹999' },
    { name: 'Kloqo Grow', price: '₹1,999' },
    { name: 'Kloqo Prime', price: '₹3,999' },
    { name: 'Free Plan (Beta)', price: 'Free' },
];

const formatTime = (time: string) => {
    try {
        return format(parse(time, 'HH:mm', new Date()), 'hh:mm a');
    } catch (e) {
        return time; // Return original if parsing fails
    }
}

export function Step7Confirm() {
  const { control, watch } = useFormContext<SignUpFormData>();
  const data = watch();
  const selectedPlan = plans.find(p => p.name === data.plan);
  const isFreePlan = data.plan === 'Free Plan (Beta)';
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  const fullAddress = [
    data.addressLine1,
    data.addressLine2,
    data.city,
    data.district,
    data.state,
    data.pincode,
  ].filter(Boolean).join(', ');

  return (
    <div>
      <p className="text-sm text-muted-foreground">Step 7/7</p>
      <h2 className="text-2xl font-bold mb-1">Confirm and Register</h2>
      <p className="text-muted-foreground mb-6">Review your clinic's information before completing the registration.</p>
      
      <ScrollArea className="h-[450px] p-2">
        <div className="space-y-6 pr-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Clinic & Owner Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><strong>Clinic Name:</strong> {data.clinicName}</p>
              <p><strong>Clinic Type:</strong> {data.clinicType}</p>
              <p><strong>Owner:</strong> {data.ownerName} ({data.designation})</p>
              <p><strong>Contact:</strong> {data.mobileNumber} / {data.emailAddress}</p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Location</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <p>{fullAddress}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Operating Hours</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data.hours.map((hour, i) => (
                <div key={i} className="flex justify-between">
                  <span>{hour.day}</span>
                  <span className="font-semibold">{hour.isClosed ? 'Closed' : hour.timeSlots.map(ts => `${formatTime(ts.open)} - ${formatTime(ts.close)}`).join(', ')}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
                <CardTitle className="text-lg">Plan & Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between items-center">
                    <span>Selected Plan:</span>
                    <Badge>{data.plan || 'Not Selected'}</Badge>
                </div>
                {selectedPlan && !isFreePlan && (
                    <div className="flex justify-between items-center">
                        <span>Monthly Amount:</span>
                        <span className="font-semibold">{selectedPlan.price}/month</span>
                    </div>
                )}
                {!isFreePlan && (
                    <div className="flex justify-between items-center">
                        <span>Payment Method:</span>
                        <span className="font-semibold">{data.paymentMethod || 'Not Selected'}</span>
                    </div>
                )}
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
      
      <div className="mt-6 space-y-4">
        <FormField
          control={control}
          name="agreeTerms"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>
                  I agree to the{' '}
                  <button
                    type="button"
                    onClick={() => setShowTermsModal(true)}
                    className="text-primary hover:underline underline-offset-2"
                  >
                    Terms of Service
                  </button>
                  {' '}and{' '}
                  <button
                    type="button"
                    onClick={() => setShowPrivacyModal(true)}
                    className="text-primary hover:underline underline-offset-2"
                  >
                    Privacy Policy
                  </button>
                </FormLabel>
                <FormMessage />
              </div>
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="isAuthorized"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>
                  I confirm I am authorized to register this clinic
                </FormLabel>
                 <FormMessage />
              </div>
            </FormItem>
          )}
        />
      </div>
      
      <div className="mt-6 pt-4 border-t flex justify-center gap-4 text-sm">
        <button
          type="button"
          onClick={() => setShowTermsModal(true)}
          className="text-primary hover:underline underline-offset-2"
        >
          Terms of Service
        </button>
        <span className="text-muted-foreground">|</span>
        <button
          type="button"
          onClick={() => setShowPrivacyModal(true)}
          className="text-primary hover:underline underline-offset-2"
        >
          Privacy Policy
        </button>
      </div>

      {/* Terms of Service Modal */}
      <Dialog open={showTermsModal} onOpenChange={setShowTermsModal}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Terms of Service</DialogTitle>
            <DialogDescription>
              Last updated: {format(new Date(), 'MMMM dd, yyyy')}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="font-semibold text-base mb-2">1. Acceptance of Terms</h3>
                <p className="text-muted-foreground">
                  By accessing and using the Kloqo platform ("Service"), you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">2. Description of Service</h3>
                <p className="text-muted-foreground">
                  Kloqo is a cloud-based clinic management platform that provides appointment scheduling, patient management, queue management, and related healthcare administration services. The Service is designed to assist medical clinics and healthcare providers in managing their operations.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">3. User Accounts and Registration</h3>
                <p className="text-muted-foreground">
                  To use the Service, you must register and create an account. You agree to:
                </p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Provide accurate, current, and complete information during registration</li>
                  <li>Maintain and promptly update your account information</li>
                  <li>Maintain the security of your password and identification</li>
                  <li>Accept all responsibility for activities that occur under your account</li>
                  <li>Notify us immediately of any unauthorized use of your account</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">4. Subscription and Payment</h3>
                <p className="text-muted-foreground">
                  The Service is provided on a subscription basis. By subscribing, you agree to:
                </p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Pay the subscription fees as specified in your selected plan</li>
                  <li>Automatic renewal of your subscription unless cancelled</li>
                  <li>All fees are non-refundable except as required by law</li>
                  <li>We reserve the right to change our pricing with 30 days' notice</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">5. Use of Service</h3>
                <p className="text-muted-foreground">
                  You agree to use the Service only for lawful purposes and in accordance with these Terms. You agree not to:
                </p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Violate any applicable laws or regulations</li>
                  <li>Infringe upon the rights of others</li>
                  <li>Transmit any harmful code or malware</li>
                  <li>Attempt to gain unauthorized access to the Service</li>
                  <li>Use the Service for any fraudulent or illegal purpose</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">6. Data and Privacy</h3>
                <p className="text-muted-foreground">
                  You are responsible for all data entered into the Service. We handle data in accordance with our Privacy Policy. You agree to:
                </p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Comply with all applicable data protection laws</li>
                  <li>Obtain necessary consents for patient data</li>
                  <li>Use data only for legitimate healthcare purposes</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">7. Intellectual Property</h3>
                <p className="text-muted-foreground">
                  The Service and its original content, features, and functionality are owned by Kloqo and are protected by international copyright, trademark, patent, trade secret, and other intellectual property laws. You may not reproduce, distribute, or create derivative works from any part of the Service without our written permission.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">8. Service Availability</h3>
                <p className="text-muted-foreground">
                  We strive to provide reliable service but do not guarantee uninterrupted or error-free operation. The Service may be temporarily unavailable due to maintenance, updates, or unforeseen circumstances. We are not liable for any losses resulting from service interruptions.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">9. Limitation of Liability</h3>
                <p className="text-muted-foreground">
                  To the maximum extent permitted by law, Kloqo shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">10. Medical Disclaimer</h3>
                <p className="text-muted-foreground">
                  The Service is a management tool and does not provide medical advice, diagnosis, or treatment. All medical decisions should be made by qualified healthcare professionals. We are not responsible for any medical decisions made using our platform.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">11. Termination</h3>
                <p className="text-muted-foreground">
                  We may terminate or suspend your account and access to the Service immediately, without prior notice, for any breach of these Terms. Upon termination, your right to use the Service will cease immediately.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">12. Changes to Terms</h3>
                <p className="text-muted-foreground">
                  We reserve the right to modify these Terms at any time. We will notify users of any material changes via email or through the Service. Continued use of the Service after changes constitutes acceptance of the new Terms.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">13. Governing Law</h3>
                <p className="text-muted-foreground">
                  These Terms shall be governed by and construed in accordance with the laws of India, without regard to its conflict of law provisions. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts in India.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">14. Contact Information</h3>
                <p className="text-muted-foreground">
                  If you have any questions about these Terms, please contact us at support@kloqo.com or through our support portal.
                </p>
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Privacy Policy Modal */}
      <Dialog open={showPrivacyModal} onOpenChange={setShowPrivacyModal}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Privacy Policy</DialogTitle>
            <DialogDescription>
              Last updated: {format(new Date(), 'MMMM dd, yyyy')}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="font-semibold text-base mb-2">1. Introduction</h3>
                <p className="text-muted-foreground">
                  Kloqo ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our clinic management platform.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">2. Information We Collect</h3>
                <p className="text-muted-foreground mb-2">We collect several types of information:</p>
                <div className="ml-4 space-y-2">
                  <div>
                    <strong className="text-foreground">Account Information:</strong>
                    <p className="text-muted-foreground">Name, email address, phone number, clinic details, and other registration information.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">Patient Data:</strong>
                    <p className="text-muted-foreground">Patient information entered by clinics using our Service, including medical records, appointment details, and contact information.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">Usage Data:</strong>
                    <p className="text-muted-foreground">Information about how you use our Service, including IP addresses, browser type, access times, and pages viewed.</p>
                  </div>
                  <div>
                    <strong className="text-foreground">Payment Information:</strong>
                    <p className="text-muted-foreground">Payment details processed through secure third-party payment processors.</p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">3. How We Use Your Information</h3>
                <p className="text-muted-foreground">We use collected information to:</p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Provide, maintain, and improve our Service</li>
                  <li>Process transactions and manage subscriptions</li>
                  <li>Send administrative information and updates</li>
                  <li>Respond to your inquiries and support requests</li>
                  <li>Monitor usage and detect security threats</li>
                  <li>Comply with legal obligations</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">4. Data Storage and Security</h3>
                <p className="text-muted-foreground">
                  We implement industry-standard security measures to protect your data, including encryption, secure servers, and regular security audits. Data is stored in secure cloud infrastructure with redundant backups. However, no method of transmission over the Internet is 100% secure.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">5. Data Sharing and Disclosure</h3>
                <p className="text-muted-foreground">We do not sell your data. We may share information only:</p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>With your explicit consent</li>
                  <li>To comply with legal obligations or court orders</li>
                  <li>With service providers who assist in operating our platform (under strict confidentiality agreements)</li>
                  <li>To protect our rights, property, or safety</li>
                  <li>In connection with a business transfer (merger, acquisition, etc.)</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">6. Patient Data and HIPAA Compliance</h3>
                <p className="text-muted-foreground">
                  As a healthcare management platform, we understand the sensitivity of patient data. We implement administrative, physical, and technical safeguards to protect patient information in accordance with applicable healthcare privacy laws, including HIPAA where applicable.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">7. Your Rights and Choices</h3>
                <p className="text-muted-foreground">You have the right to:</p>
                <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                  <li>Access and receive a copy of your data</li>
                  <li>Correct inaccurate or incomplete information</li>
                  <li>Request deletion of your account and data (subject to legal retention requirements)</li>
                  <li>Opt-out of marketing communications</li>
                  <li>Request data portability</li>
                  <li>Object to certain processing activities</li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">8. Data Retention</h3>
                <p className="text-muted-foreground">
                  We retain your information for as long as your account is active or as needed to provide services. We may retain certain information longer as required by law, for legal proceedings, or to resolve disputes. Upon account termination, we will delete or anonymize your data within 30 days, unless longer retention is required by law.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">9. Cookies and Tracking Technologies</h3>
                <p className="text-muted-foreground">
                  We use cookies and similar technologies to enhance your experience, analyze usage patterns, and improve our Service. You can control cookie preferences through your browser settings, though this may affect Service functionality.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">10. Third-Party Links</h3>
                <p className="text-muted-foreground">
                  Our Service may contain links to third-party websites or services. We are not responsible for the privacy practices of these third parties. We encourage you to review their privacy policies.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">11. International Data Transfers</h3>
                <p className="text-muted-foreground">
                  Your information may be transferred to and processed in countries other than your country of residence. We ensure appropriate safeguards are in place to protect your data in accordance with this Privacy Policy.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">12. Children's Privacy</h3>
                <p className="text-muted-foreground">
                  Our Service is not intended for children under 18. We do not knowingly collect personal information from children. If we discover that we have collected information from a child, we will delete it immediately.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">13. Changes to Privacy Policy</h3>
                <p className="text-muted-foreground">
                  We may update this Privacy Policy from time to time. We will notify you of any material changes via email or through the Service. Your continued use of the Service after changes indicates acceptance of the updated policy.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-base mb-2">14. Contact Us</h3>
                <p className="text-muted-foreground">
                  If you have questions or concerns about this Privacy Policy or our data practices, please contact us at:
                </p>
                <p className="text-muted-foreground mt-2">
                  Email: privacy@kloqo.com<br />
                  Support: support@kloqo.com
                </p>
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
