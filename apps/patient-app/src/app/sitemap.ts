import { MetadataRoute } from 'next';
import { getFirestore, collection, getDocs } from 'firebase/firestore/lite';
import { getServerFirebaseApp } from '@/lib/firebase-server-app';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const baseUrl = 'https://kloqo.com';

    // Static routes
    const routes = [
        '',
        '/login',
        '/doctors',
    ].map((route) => ({
        url: `${baseUrl}${route}`,
        lastModified: new Date(),
        changeFrequency: 'daily' as const,
        priority: 1,
    }));

    // Dynamic doctor routes
    let doctorRoutes: MetadataRoute.Sitemap = [];
    try {
        const firestore = getFirestore(getServerFirebaseApp());
        const snapshot = await getDocs(collection(firestore, 'doctors'));
        doctorRoutes = snapshot.docs.map((doc) => ({
            url: `${baseUrl}/doctors/${doc.id}`,
            lastModified: new Date(), // Ideally this would be doc.data().updatedAt
            changeFrequency: 'weekly' as const,
            priority: 0.8,
        }));
    } catch (error) {
        console.error('Failed to generate doctor sitemap:', error);
    }

    return [...routes, ...doctorRoutes];
}
