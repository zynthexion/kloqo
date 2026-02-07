export default function PrivacyPolicy() {
    return (
        <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-md p-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-4">Privacy Policy</h1>
                <p className="text-sm text-gray-600 mb-8">Last updated: February 7, 2026</p>

                <div className="space-y-6 text-gray-700">
                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">1. Introduction</h2>
                        <p>
                            Welcome to Kloqo. We are committed to protecting your personal information and your right to privacy.
                            This Privacy Policy explains how we collect, use, and share information when you use our clinic queue
                            management and appointment booking services.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">2. Information We Collect</h2>
                        <p className="mb-2">We collect the following types of information:</p>
                        <ul className="list-disc pl-6 space-y-2">
                            <li><strong>Personal Information:</strong> Name, phone number, and email address (when provided)</li>
                            <li><strong>Appointment Data:</strong> Clinic visits, appointment times, and queue positions</li>
                            <li><strong>Communication Data:</strong> Messages sent via WhatsApp for appointment confirmations and updates</li>
                            <li><strong>Usage Data:</strong> How you interact with our application and services</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">3. How We Use WhatsApp</h2>
                        <p className="mb-2">We use WhatsApp Business API to:</p>
                        <ul className="list-disc pl-6 space-y-2">
                            <li>Send appointment confirmations and reminders</li>
                            <li>Provide real-time queue status updates</li>
                            <li>Notify you when it's your turn to see the doctor</li>
                            <li>Respond to your inquiries about clinic availability and booking</li>
                            <li>Send important updates about your appointments</li>
                        </ul>
                        <p className="mt-3">
                            All WhatsApp communications are sent only with your consent and you can opt-out at any time by
                            contacting us or blocking our number.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">4. How We Use Your Information</h2>
                        <p className="mb-2">We use your information to:</p>
                        <ul className="list-disc pl-6 space-y-2">
                            <li>Manage your appointments and queue positions</li>
                            <li>Send you notifications about your clinic visits</li>
                            <li>Improve our services and user experience</li>
                            <li>Communicate with you about service updates</li>
                            <li>Comply with legal obligations</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">5. Data Storage and Security</h2>
                        <p>
                            Your data is stored securely using Firebase (Google Cloud Platform) with industry-standard encryption.
                            We implement appropriate technical and organizational measures to protect your personal information
                            against unauthorized access, alteration, disclosure, or destruction.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">6. Data Sharing</h2>
                        <p className="mb-2">We do not sell your personal information. We may share your information with:</p>
                        <ul className="list-disc pl-6 space-y-2">
                            <li><strong>Healthcare Providers:</strong> The clinics you book appointments with</li>
                            <li><strong>Service Providers:</strong> Third-party services that help us operate (Firebase, WhatsApp Business API)</li>
                            <li><strong>Legal Requirements:</strong> When required by law or to protect our rights</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">7. Your Rights</h2>
                        <p className="mb-2">You have the right to:</p>
                        <ul className="list-disc pl-6 space-y-2">
                            <li>Access your personal information</li>
                            <li>Correct inaccurate data</li>
                            <li>Request deletion of your data</li>
                            <li>Opt-out of WhatsApp notifications</li>
                            <li>Withdraw consent at any time</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">8. Data Retention</h2>
                        <p>
                            We retain your personal information only for as long as necessary to provide our services and comply
                            with legal obligations. Appointment data is typically retained for 1 year for medical record purposes.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">9. Children's Privacy</h2>
                        <p>
                            Our services are not directed to children under 13. We do not knowingly collect personal information
                            from children under 13. If you believe we have collected such information, please contact us immediately.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">10. Changes to This Policy</h2>
                        <p>
                            We may update this Privacy Policy from time to time. We will notify you of any changes by posting the
                            new Privacy Policy on this page and updating the "Last updated" date.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">11. Contact Us</h2>
                        <p className="mb-2">If you have any questions about this Privacy Policy, please contact us:</p>
                        <ul className="list-none space-y-1">
                            <li><strong>Email:</strong> privacy@kloqo.com</li>
                            <li><strong>Website:</strong> https://app.kloqo.com</li>
                        </ul>
                    </section>
                </div>

                <div className="mt-8 pt-6 border-t border-gray-200">
                    <p className="text-sm text-gray-600">
                        By using Kloqo services, you acknowledge that you have read and understood this Privacy Policy.
                    </p>
                </div>
            </div>
        </div>
    );
}
