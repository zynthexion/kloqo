import { NextRequest, NextResponse } from 'next/server';

/**
 * API endpoint to resolve short URLs by following redirects
 * This is needed because short URL services redirect to the final destination
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json(
        { error: 'URL parameter is required' },
        { status: 400 }
      );
    }

    // Validate URL format
    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    // Follow redirects recursively until we reach the final destination
    console.log('🔗 Resolving URL:', url);
    
    const MAX_REDIRECTS = 10; // Prevent infinite loops
    let currentUrl = url;
    let redirectCount = 0;
    const visitedUrls = new Set<string>(); // Prevent redirect loops
    const shortUrlPatterns = [
      /(me-qr\.com|bit\.ly|tinyurl|t\.co|goo\.gl|short\.link|ow\.ly|is\.gd|scan\.page)/i
    ];
    
    try {
      while (redirectCount < MAX_REDIRECTS) {
        // Check for redirect loops
        if (visitedUrls.has(currentUrl)) {
          console.log('🔗 Circular redirect detected:', currentUrl);
          break;
        }
        visitedUrls.add(currentUrl);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
          console.log('🔗 Request timeout for:', currentUrl);
        }, 10000); // 10 seconds per request

        try {
          // Use GET with automatic redirect following
          // Fetch will follow all HTTP redirects automatically
          const response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'follow', // Let fetch follow redirects automatically
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; KloqoApp/1.0)',
            },
          });

          clearTimeout(timeoutId);
          
          // Get the final URL after fetch automatically followed all redirects
          const finalUrl = response.url || currentUrl;
          console.log(`🔗 Fetch result: ${currentUrl} -> ${finalUrl} (status: ${response.status})`);
          
          // Check if we've reached a final destination (not another short URL)
          const isShortUrlService = shortUrlPatterns.some(pattern => pattern.test(finalUrl));
          
          if (!isShortUrlService) {
            // Final destination reached
            console.log(`🔗 Resolved to final URL after ${redirectCount} redirect(s):`, finalUrl);
            return NextResponse.json({
              originalUrl: url,
              finalUrl: finalUrl,
              status: response.status,
              redirectCount: redirectCount,
            });
          }
          
          // Still a short URL - continue following redirects
          // If finalUrl changed, it means redirects happened, continue with new URL
          if (finalUrl !== currentUrl) {
            console.log(`🔗 Redirect ${redirectCount + 1}: ${currentUrl} -> ${finalUrl} (continuing...)`);
            currentUrl = finalUrl;
            redirectCount++;
            continue; // Continue the while loop
          }
          
          // No redirect happened (finalUrl === currentUrl), might be JavaScript-based
          console.log(`🔗 No HTTP redirect, checking HTML for JavaScript redirects: ${currentUrl}`);
          try {
            const htmlText = await response.text();
            
            // Try to extract redirect from HTML (meta refresh, JavaScript, etc.)
            // Meta refresh with various formats
            const metaRefreshPatterns = [
              /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i,
              /<meta[^>]*content=["'][^"']*url=([^"'>\s]+)[^"']*http-equiv=["']refresh["']/i,
            ];
            
            for (const pattern of metaRefreshPatterns) {
              const match = htmlText.match(pattern);
              if (match && match[1]) {
                try {
                  const redirectUrl = new URL(match[1].trim(), currentUrl).href;
                  console.log(`🔗 Found meta refresh redirect: ${redirectUrl}`);
                  const metaIsShortUrl = shortUrlPatterns.some(p => p.test(redirectUrl));
                  if (!metaIsShortUrl) {
                    return NextResponse.json({
                      originalUrl: url,
                      finalUrl: redirectUrl,
                      status: 200,
                      redirectCount: redirectCount + 1,
                    });
                  }
                  currentUrl = redirectUrl;
                  redirectCount++;
                  continue; // Continue while loop
                } catch (e) {
                  console.log('🔗 Invalid redirect URL from meta:', match[1]);
                }
              }
            }
            
            // Try to find JavaScript redirects (various patterns)
            const jsRedirectPatterns = [
              /(?:window\.location|location\.href|window\.location\.href)\s*=\s*["']([^"']+)["']/i,
              /(?:window\.location|location\.href|window\.location\.href)\s*=\s*([^;]+);/i,
              /location\.replace\(["']([^"']+)["']\)/i,
              /location\.assign\(["']([^"']+)["']\)/i,
            ];
            
            for (const pattern of jsRedirectPatterns) {
              const match = htmlText.match(pattern);
              if (match && match[1]) {
                try {
                  const redirectUrl = new URL(match[1].trim(), currentUrl).href;
                  console.log(`🔗 Found JavaScript redirect: ${redirectUrl}`);
                  const jsIsShortUrl = shortUrlPatterns.some(p => p.test(redirectUrl));
                  if (!jsIsShortUrl) {
                    return NextResponse.json({
                      originalUrl: url,
                      finalUrl: redirectUrl,
                      status: 200,
                      redirectCount: redirectCount + 1,
                    });
                  }
                  currentUrl = redirectUrl;
                  redirectCount++;
                  continue; // Continue while loop
                } catch (e) {
                  console.log('🔗 Invalid redirect URL from JavaScript:', match[1]);
                }
              }
            }
            
            // If still a short URL and no redirect found, return current URL
            console.log(`🔗 No redirect found in HTML, returning current URL: ${currentUrl}`);
            return NextResponse.json({
              originalUrl: url,
              finalUrl: currentUrl,
              status: 200,
              redirectCount: redirectCount,
              warning: 'No redirect found in HTML',
            });
          } catch (htmlError: any) {
            console.error('🔗 Error fetching HTML:', htmlError);
            // Fall through to return current URL
          }
          
        } catch (fetchError: any) {
          clearTimeout(timeoutId);
          console.error('🔗 Error fetching URL:', fetchError);
          throw fetchError;
        }
      }
      
      // If we've exhausted redirects, return the last URL we got
      console.log(`🔗 Max redirects reached (${MAX_REDIRECTS}), returning last URL:`, currentUrl);
      return NextResponse.json({
        originalUrl: url,
        finalUrl: currentUrl,
        status: 200,
        redirectCount: redirectCount,
        warning: 'Max redirects reached',
      });
      
    } catch (fetchError: any) {
      console.error('🔗 Failed to resolve URL:', fetchError);
      return NextResponse.json(
        {
          error: 'Failed to resolve URL',
          message: fetchError.message || 'Unknown error',
          originalUrl: url,
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Error in resolve-url API:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error.message,
      },
      { status: 500 }
    );
  }
}

