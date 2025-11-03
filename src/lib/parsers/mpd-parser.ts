/**
 * MPD (DASH) manifest parser
 */

import { DASHManifest, DASHRepresentation, SegmentInfo } from '../types';
import { resolveUrl } from '../utils/url-utils';
import { ParseError } from '../utils/errors';
import { logger } from '../utils/logger';

export class MPDParser {
  /**
   * Parse MPD manifest from XML
   */
  static async parse(mpdUrl: string): Promise<DASHManifest> {
    try {
      const response = await fetch(mpdUrl);
      
      if (!response.ok) {
        throw new ParseError(`Failed to fetch MPD: ${response.statusText}`);
      }
      
      const xmlText = await response.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      
      // Check for parsing errors
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        throw new ParseError('Failed to parse MPD XML');
      }
      
      const mpd = xmlDoc.querySelector('MPD');
      if (!mpd) {
        throw new ParseError('Invalid MPD format: No MPD element found');
      }
      
      const baseUrl = mpdUrl;
      const period = xmlDoc.querySelector('Period') || mpd;
      const adaptations = Array.from(period.querySelectorAll('AdaptationSet'));
      
      const videoRepresentations: DASHRepresentation[] = [];
      const audioRepresentations: DASHRepresentation[] = [];
      
      for (const adaptation of adaptations) {
        const contentType = 
          adaptation.getAttribute('contentType') ||
          adaptation.getAttribute('mimeType') ||
          this.inferContentType(adaptation);
        
        if (contentType !== 'video' && contentType !== 'audio') {
          continue;
        }
        
        const representations = Array.from(adaptation.querySelectorAll('Representation'));
        
        for (const rep of representations) {
          const id = rep.getAttribute('id') || '';
          const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0');
          const width = rep.getAttribute('width') ? parseInt(rep.getAttribute('width')!) : undefined;
          const height = rep.getAttribute('height') ? parseInt(rep.getAttribute('height')!) : undefined;
          const codecs = rep.getAttribute('codecs') || undefined;
          
          // Get base URL from Representation, AdaptationSet, or Period
          const baseUrlStr = 
            rep.getAttribute('baseURL') ||
            adaptation.querySelector('BaseURL')?.textContent ||
            period.querySelector('BaseURL')?.textContent ||
            '';
          
          // Get segment information
          const segmentTemplate = rep.querySelector('SegmentTemplate');
          const segmentList = rep.querySelector('SegmentList');
          const segmentBase = rep.querySelector('SegmentBase');
          
          let segments: { initUrl?: string; segments: SegmentInfo[] };
          
          if (segmentTemplate) {
            segments = this.parseSegmentTemplate(segmentTemplate, rep, baseUrl, baseUrlStr);
          } else if (segmentList) {
            segments = this.parseSegmentList(segmentList, rep, baseUrl, baseUrlStr);
          } else if (segmentBase) {
            segments = this.parseSegmentBase(segmentBase, rep, baseUrl, baseUrlStr);
          } else {
            // Fallback: single segment
            const mediaUrl = rep.getAttribute('baseURL') || baseUrl;
            segments = {
              segments: [{
                url: resolveUrl(mediaUrl, baseUrl),
                sequence: 0,
              }],
            };
          }
          
          const representation: DASHRepresentation = {
            id,
            type: contentType as 'video' | 'audio',
            bandwidth,
            width,
            height,
            codecs,
            segments,
          };
          
          if (contentType === 'video') {
            videoRepresentations.push(representation);
          } else {
            audioRepresentations.push(representation);
          }
        }
      }
      
      // Sort by bandwidth (highest first)
      videoRepresentations.sort((a, b) => b.bandwidth - a.bandwidth);
      audioRepresentations.sort((a, b) => b.bandwidth - a.bandwidth);
      
      return {
        video: videoRepresentations,
        audio: audioRepresentations,
        baseUrl,
      };
    } catch (error) {
      if (error instanceof ParseError) {
        throw error;
      }
      throw new ParseError(`Failed to parse MPD: ${error}`);
    }
  }

  /**
   * Parse SegmentTemplate
   */
  private static parseSegmentTemplate(
    template: Element,
    representation: Element,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const media = template.getAttribute('media') || '$RepresentationID$_$Number$.m4s';
    const initialization = template.getAttribute('initialization') || '$RepresentationID$_init.m4s';
    const startNumber = parseInt(template.getAttribute('startNumber') || '1');
    const duration = parseFloat(template.getAttribute('duration') || '0');
    const timescale = parseFloat(template.getAttribute('timescale') || '1');
    const segmentDuration = duration / timescale;
    
    const repId = representation.getAttribute('id') || '';
    
    // Get segment count from SegmentTimeline or duration
    let segmentCount = 1;
    const segmentTimeline = template.querySelector('SegmentTimeline');
    
    if (segmentTimeline) {
      const S = segmentTimeline.querySelectorAll('S');
      segmentCount = S.length;
      
      // Calculate total duration from timeline
      let totalDuration = 0;
      S.forEach(seg => {
        const d = parseFloat(seg.getAttribute('d') || '0');
        const timescale = parseFloat(seg.getAttribute('timescale') || template.getAttribute('timescale') || '1');
        totalDuration += d / timescale;
      });
    } else if (duration > 0) {
      // Estimate from presentation duration
      const period = representation.closest('Period');
      const mpd = period?.closest('MPD');
      const presentationDuration = mpd?.getAttribute('mediaPresentationDuration');
      
      if (presentationDuration) {
        // Parse ISO 8601 duration (e.g., PT123.456S)
        const match = presentationDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
        if (match) {
          const hours = parseInt(match[1] || '0');
          const minutes = parseInt(match[2] || '0');
          const seconds = parseFloat(match[3] || '0');
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          if (segmentDuration > 0) {
            segmentCount = Math.ceil(totalSeconds / segmentDuration);
          }
        }
      }
    }
    
    // Build initialization URL
    const initUrl = initialization
      .replace(/\$RepresentationID\$/g, repId)
      .replace(/\$Bandwidth\$/g, representation.getAttribute('bandwidth') || '');
    
    const segments: SegmentInfo[] = [];
    const templateBase = baseUrlStr || '';
    
    // Build segment URLs
    for (let i = startNumber; i < startNumber + segmentCount; i++) {
      const segmentUrl = media
        .replace(/\$RepresentationID\$/g, repId)
        .replace(/\$Number\$/g, i.toString())
        .replace(/\$Bandwidth\$/g, representation.getAttribute('bandwidth') || '');
      
      segments.push({
        url: resolveUrl(segmentUrl, templateBase || baseUrl),
        sequence: i,
        duration: segmentDuration,
      });
    }
    
    return {
      initUrl: initUrl ? resolveUrl(initUrl, templateBase || baseUrl) : undefined,
      segments,
    };
  }

  /**
   * Parse SegmentList
   */
  private static parseSegmentList(
    segmentList: Element,
    representation: Element,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const segments: SegmentInfo[] = [];
    const base = baseUrlStr || '';
    
    const initSegments = segmentList.querySelectorAll('Initialization');
    let initUrl: string | undefined;
    
    if (initSegments.length > 0) {
      const init = initSegments[0];
      const sourceUrl = init.getAttribute('sourceURL') || init.textContent || '';
      if (sourceUrl) {
        initUrl = resolveUrl(sourceUrl, base || baseUrl);
      }
    }
    
    segmentList.querySelectorAll('SegmentURL').forEach((seg, index) => {
      const media = seg.getAttribute('media') || seg.textContent || '';
      if (media) {
        segments.push({
          url: resolveUrl(media, base || baseUrl),
          sequence: index,
        });
      }
    });
    
    return { initUrl, segments };
  }

  /**
   * Parse SegmentBase
   */
  private static parseSegmentBase(
    segmentBase: Element,
    representation: Element,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const base = baseUrlStr || '';
    const initialization = segmentBase.querySelector('Initialization');
    
    let initUrl: string | undefined;
    if (initialization) {
      const sourceUrl = initialization.getAttribute('sourceURL') || initialization.textContent || '';
      if (sourceUrl) {
        initUrl = resolveUrl(sourceUrl, base || baseUrl);
      }
    }
    
    // SegmentBase typically has a single media segment
    const mediaUrl = representation.getAttribute('baseURL') || baseUrl;
    
    return {
      initUrl,
      segments: [{
        url: resolveUrl(mediaUrl, base || baseUrl),
        sequence: 0,
      }],
    };
  }

  /**
   * Infer content type from AdaptationSet
   */
  private static inferContentType(adaptation: Element): string {
    // Check mimeType
    const mimeType = adaptation.getAttribute('mimeType') || '';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    
    // Check codecs
    const codecs = adaptation.getAttribute('codecs') || '';
    if (codecs.includes('avc') || codecs.includes('hev') || codecs.includes('vp')) return 'video';
    if (codecs.includes('mp4a') || codecs.includes('opus')) return 'audio';
    
    // Default to video if has width/height
    if (adaptation.getAttribute('width') || adaptation.getAttribute('height')) {
      return 'video';
    }
    
    return 'audio';
  }
}

