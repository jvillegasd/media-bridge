/**
 * MPD (DASH) manifest parser
   * Uses text-based parsing for service worker compatibility (DOMParser not available)
 */

import { DASHManifest, DASHRepresentation, SegmentInfo } from '../types';
import { resolveUrl } from '../utils/url-utils';
import { ParseError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Simple XML element representation for text-based parsing
 */
interface XMLElement {
  tagName: string;
  attributes: Map<string, string>;
  textContent: string;
  children: XMLElement[];
  parent?: XMLElement;
}

/**
 * Simple XML parser for service worker context
 */
class SimpleXMLParser {
  static parse(xmlText: string): XMLElement {
    try {
      // Remove XML declaration and comments
      xmlText = xmlText.replace(/<\?xml[^>]*\?>/gi, '');
      xmlText = xmlText.replace(/<!--[\s\S]*?-->/g, '');
      
      // Handle CDATA sections - extract content
      xmlText = xmlText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      
      const trimmed = xmlText.trim();
      if (!trimmed) {
        logger.error('XML text is empty after processing');
        throw new ParseError('Failed to parse XML: Empty XML text');
      }
      
      const root = this.parseElement(trimmed);
      if (!root) {
        logger.error(`Failed to parse XML. First 500 chars: ${trimmed.substring(0, 500)}`);
        throw new ParseError('Failed to parse XML: Could not find root element');
      }
      return root;
    } catch (error) {
      if (error instanceof ParseError) {
        throw error;
      }
      logger.error(`XML parsing error: ${error}`, error);
      throw new ParseError(`Failed to parse XML: ${error}`);
    }
  }

  private static parseElement(text: string, parent?: XMLElement): XMLElement | null {
    text = text.trim();
    if (!text.startsWith('<')) return null;

    // Match opening tag - handle namespaces like <dash:MPD> or <MPD>
    const tagMatch = text.match(/^<([\w:.-]+)([^>]*)>/);
    if (!tagMatch) {
      logger.debug(`No tag match found. Text start: ${text.substring(0, 100)}`);
      return null;
    }

    const tagName = tagMatch[1];
    const attributesStr = tagMatch[2];
    
    // Parse attributes - handle namespaces and special characters in values
    const attributes = new Map<string, string>();
    // More robust attribute parsing that handles escaped quotes and special characters
    const attrRegex = /([\w:-]+)=(["'])((?:(?!\2)[^\\]|\\.)*)\2/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
      const attrName = attrMatch[1];
      let attrValue = attrMatch[3];
      // Unescape common escape sequences
      attrValue = attrValue.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      attributes.set(attrName, attrValue);
    }
    
    // Also try to handle attributes without quotes (though not standard, some malformed XML may have this)
    const unquotedAttrRegex = /([\w:-]+)=([^\s>]+)/g;
    let unquotedMatch;
    while ((unquotedMatch = unquotedAttrRegex.exec(attributesStr)) !== null) {
      if (!attributes.has(unquotedMatch[1])) {
        attributes.set(unquotedMatch[1], unquotedMatch[2]);
      }
    }

    // Check if self-closing
    const isSelfClosing = attributesStr.trim().endsWith('/') || text.match(new RegExp(`^<${tagName}[^>]*/>`));
    
    const element: XMLElement = {
      tagName,
      attributes,
      textContent: '',
      children: [],
      parent,
    };

    if (isSelfClosing) {
      return element;
    }

    // Find matching closing tag
    const tagStart = tagMatch[0];
    const contentStart = tagStart.length;
    
    // Find closing tag position
    let pos = contentStart;
    let depth = 1;
    const children: XMLElement[] = [];
    let textContent = '';
    
    while (depth > 0 && pos < text.length) {
      // Look for next tag
      const nextTagPos = text.indexOf('<', pos);
      if (nextTagPos === -1) break;
      
      // Check if it's a closing tag
      const closeMatch = text.substring(nextTagPos).match(/^<\/([\w:]+)>/);
      if (closeMatch) {
        const closeTagName = closeMatch[1];
        if (closeTagName === tagName && depth === 1) {
          // This is our closing tag
          textContent += text.substring(pos, nextTagPos);
          pos = nextTagPos + closeMatch[0].length;
          break;
        } else if (closeTagName === tagName) {
          depth--;
          pos = nextTagPos + closeMatch[0].length;
          continue;
        }
      }
      
      // Check if it's an opening tag
      const openMatch = text.substring(nextTagPos).match(/^<([\w:]+)([^>]*)>/);
      if (openMatch) {
        const openTagName = openMatch[1];
        
        // Add text before this tag
        textContent += text.substring(pos, nextTagPos);
        
        // Check if self-closing
        const isSelfClose = openMatch[2].trim().endsWith('/') || 
                           text.substring(nextTagPos).match(new RegExp(`^<${openTagName}[^>]*/>`));
        
        if (isSelfClose) {
          pos = nextTagPos + openMatch[0].length;
          continue;
        }
        
        if (openTagName === tagName) {
          depth++;
          pos = nextTagPos + openMatch[0].length;
        } else {
          // Parse child element
          const childEnd = this.findMatchingCloseTag(text, nextTagPos, openTagName);
          if (childEnd > 0) {
            const childText = text.substring(nextTagPos, childEnd);
            const child = this.parseElement(childText, element);
            if (child) {
              children.push(child);
            }
            pos = childEnd;
          } else {
            pos = nextTagPos + openMatch[0].length;
          }
        }
      } else {
        pos++;
      }
    }

    element.textContent = textContent.trim();
    element.children = children;
    
    return element;
  }

  private static findMatchingCloseTag(text: string, start: number, tagName: string): number {
    let depth = 1;
    let pos = start;
    
    // Skip opening tag
    const openMatch = text.substring(pos).match(new RegExp(`^<${tagName}[^>]*>`));
    if (openMatch) {
      pos += openMatch[0].length;
    }

    while (depth > 0 && pos < text.length) {
      const nextOpen = text.substring(pos).match(new RegExp(`<${tagName}[^>]*>`));
      const nextClose = text.substring(pos).match(new RegExp(`</${tagName}>`));

      if (nextClose && (!nextOpen || nextClose.index! < nextOpen.index!)) {
        depth--;
        if (depth === 0) {
          return pos + nextClose.index! + nextClose[0].length;
        }
        pos += nextClose.index! + nextClose[0].length;
      } else if (nextOpen) {
        depth++;
        pos += nextOpen.index! + nextOpen[0].length;
      } else {
        pos++;
      }
    }

    return -1;
  }
}

export class MPDParser {
  /**
   * Parse MPD manifest from XML
   */
  static async parse(mpdUrl: string): Promise<DASHManifest> {
    try {
      logger.info(`Fetching MPD from: ${mpdUrl}`);
      const response = await fetch(mpdUrl);
      
      if (!response.ok) {
        const statusText = await response.text().catch(() => response.statusText);
        logger.error(`Failed to fetch MPD: ${response.status} ${response.statusText}`);
        throw new ParseError(`Failed to fetch MPD: ${response.status} ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type') || '';
      logger.debug(`MPD response content-type: ${contentType}`);
      
      const xmlText = await response.text();
      
      // Validate that we received XML
      if (!xmlText.trim().startsWith('<') && !xmlText.trim().startsWith('<?xml')) {
        logger.error(`Response doesn't appear to be XML. First 200 chars: ${xmlText.substring(0, 200)}`);
        throw new ParseError(`Failed to parse MPD: Response is not valid XML. Content type: ${contentType}, First 200 chars: ${xmlText.substring(0, 200)}`);
      }
      
      logger.debug(`Parsing MPD XML (length: ${xmlText.length} chars)`);
      const xmlDoc = SimpleXMLParser.parse(xmlText);
      
      // Check for parsing errors
      if (xmlDoc.tagName === 'parsererror') {
        throw new ParseError('Failed to parse MPD XML');
      }
      
      // Handle namespace prefixes like "dash:MPD" or just "MPD"
      const mpdLocalName = xmlDoc.tagName.includes(':') ? xmlDoc.tagName.split(':').pop()! : xmlDoc.tagName;
      if (mpdLocalName !== 'MPD') {
        logger.error(`Invalid MPD format: Expected MPD element, got ${xmlDoc.tagName}`);
        throw new ParseError(`Invalid MPD format: Expected MPD element, got ${xmlDoc.tagName}`);
      }
      
      const baseUrl = mpdUrl;
      const period = this.findChild(xmlDoc, 'Period') || xmlDoc;
      const adaptations = this.findAllChildren(period, 'AdaptationSet');
      
      const videoRepresentations: DASHRepresentation[] = [];
      const audioRepresentations: DASHRepresentation[] = [];
      
      for (const adaptation of adaptations) {
        const contentType = 
          this.getAttribute(adaptation, 'contentType') ||
          this.getAttribute(adaptation, 'mimeType') ||
          this.inferContentType(adaptation);
        
        if (contentType !== 'video' && contentType !== 'audio') {
          continue;
        }
        
        const representations = this.findAllChildren(adaptation, 'Representation');
        
        for (const rep of representations) {
          const id = this.getAttribute(rep, 'id') || '';
          const bandwidth = parseInt(this.getAttribute(rep, 'bandwidth') || '0');
          const width = this.getAttribute(rep, 'width') ? parseInt(this.getAttribute(rep, 'width')!) : undefined;
          const height = this.getAttribute(rep, 'height') ? parseInt(this.getAttribute(rep, 'height')!) : undefined;
          const codecs = this.getAttribute(rep, 'codecs') || undefined;
          
          // Get base URL from Representation, AdaptationSet, or Period
          const baseUrlStr = 
            this.getAttribute(rep, 'baseURL') ||
            this.findChild(rep, 'BaseURL')?.textContent ||
            this.findChild(adaptation, 'BaseURL')?.textContent ||
            this.findChild(period, 'BaseURL')?.textContent ||
            '';
          
          // Get segment information
          const segmentTemplate = this.findChild(rep, 'SegmentTemplate');
          const segmentList = this.findChild(rep, 'SegmentList');
          const segmentBase = this.findChild(rep, 'SegmentBase');
          
          let segments: { initUrl?: string; segments: SegmentInfo[] };
          
          if (segmentTemplate) {
            segments = this.parseSegmentTemplate(segmentTemplate, rep, baseUrl, baseUrlStr);
          } else if (segmentList) {
            segments = this.parseSegmentList(segmentList, rep, baseUrl, baseUrlStr);
          } else if (segmentBase) {
            segments = this.parseSegmentBase(segmentBase, rep, baseUrl, baseUrlStr);
          } else {
            // Fallback: single segment
            const mediaUrl = this.getAttribute(rep, 'baseURL') || baseUrl;
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
    template: XMLElement,
    representation: XMLElement,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const media = this.getAttribute(template, 'media') || '$RepresentationID$_$Number$.m4s';
    const initialization = this.getAttribute(template, 'initialization') || '$RepresentationID$_init.m4s';
    const startNumber = parseInt(this.getAttribute(template, 'startNumber') || '1');
    const duration = parseFloat(this.getAttribute(template, 'duration') || '0');
    const timescale = parseFloat(this.getAttribute(template, 'timescale') || '1');
    const segmentDuration = duration / timescale;
    
    const repId = this.getAttribute(representation, 'id') || '';
    
    // Get segment count from SegmentTimeline or duration
    let segmentCount = 1;
    const segmentTimeline = this.findChild(template, 'SegmentTimeline');
    
    if (segmentTimeline) {
      const S = this.findAllChildren(segmentTimeline, 'S');
      segmentCount = S.length;
      
      // Calculate total duration from timeline
      let totalDuration = 0;
      S.forEach(seg => {
        const d = parseFloat(this.getAttribute(seg, 'd') || '0');
        const timescaleAttr = this.getAttribute(seg, 'timescale') || this.getAttribute(template, 'timescale') || '1';
        totalDuration += d / parseFloat(timescaleAttr);
      });
    } else if (duration > 0) {
      // Estimate from presentation duration
      const period = this.findParentWithTag(representation, 'Period');
      const mpd = period ? this.findParentWithTag(period, 'MPD') : null;
      const presentationDuration = mpd ? this.getAttribute(mpd, 'mediaPresentationDuration') : null;
      
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
      .replace(/\$Bandwidth\$/g, this.getAttribute(representation, 'bandwidth') || '');
    
    const segments: SegmentInfo[] = [];
    const templateBase = baseUrlStr || '';
    
    // Build segment URLs
    for (let i = startNumber; i < startNumber + segmentCount; i++) {
      const segmentUrl = media
        .replace(/\$RepresentationID\$/g, repId)
        .replace(/\$Number\$/g, i.toString())
        .replace(/\$Bandwidth\$/g, this.getAttribute(representation, 'bandwidth') || '');
      
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
    segmentList: XMLElement,
    representation: XMLElement,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const segments: SegmentInfo[] = [];
    const base = baseUrlStr || '';
    
    const initSegments = this.findAllChildren(segmentList, 'Initialization');
    let initUrl: string | undefined;
    
    if (initSegments.length > 0) {
      const init = initSegments[0];
      const sourceUrl = this.getAttribute(init, 'sourceURL') || init.textContent || '';
      if (sourceUrl) {
        initUrl = resolveUrl(sourceUrl, base || baseUrl);
      }
    }
    
    const segmentUrls = this.findAllChildren(segmentList, 'SegmentURL');
    segmentUrls.forEach((seg, index) => {
      const media = this.getAttribute(seg, 'media') || seg.textContent || '';
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
    segmentBase: XMLElement,
    representation: XMLElement,
    baseUrl: string,
    baseUrlStr: string
  ): { initUrl?: string; segments: SegmentInfo[] } {
    const base = baseUrlStr || '';
    const initialization = this.findChild(segmentBase, 'Initialization');
    
    let initUrl: string | undefined;
    if (initialization) {
      const sourceUrl = this.getAttribute(initialization, 'sourceURL') || initialization.textContent || '';
      if (sourceUrl) {
        initUrl = resolveUrl(sourceUrl, base || baseUrl);
      }
    }
    
    // SegmentBase typically has a single media segment
    const mediaUrl = this.getAttribute(representation, 'baseURL') || baseUrl;
    
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
  private static inferContentType(adaptation: XMLElement): string {
    // Check mimeType
    const mimeType = this.getAttribute(adaptation, 'mimeType') || '';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    
    // Check codecs
    const codecs = this.getAttribute(adaptation, 'codecs') || '';
    if (codecs.includes('avc') || codecs.includes('hev') || codecs.includes('vp')) return 'video';
    if (codecs.includes('mp4a') || codecs.includes('opus')) return 'audio';
    
    // Default to video if has width/height
    if (this.getAttribute(adaptation, 'width') || this.getAttribute(adaptation, 'height')) {
      return 'video';
    }
    
    return 'audio';
  }

  /**
   * Helper methods for XML element access
   */
  private static getAttribute(element: XMLElement, name: string): string | null {
    return element.attributes.get(name) || null;
  }

  private static findChild(element: XMLElement, tagName: string): XMLElement | null {
    // Handle namespaces - match both "Period" and "dash:Period"
    const localName = tagName.includes(':') ? tagName.split(':').pop()! : tagName;
    return element.children.find(child => {
      const childLocalName = child.tagName.includes(':') ? child.tagName.split(':').pop()! : child.tagName;
      return childLocalName === localName || child.tagName === tagName;
    }) || null;
  }

  private static findAllChildren(element: XMLElement, tagName: string): XMLElement[] {
    // Handle namespaces - match both "Period" and "dash:Period"
    const localName = tagName.includes(':') ? tagName.split(':').pop()! : tagName;
    return element.children.filter(child => {
      const childLocalName = child.tagName.includes(':') ? child.tagName.split(':').pop()! : child.tagName;
      return childLocalName === localName || child.tagName === tagName;
    });
  }

  private static findParentWithTag(element: XMLElement, tagName: string): XMLElement | null {
    let parent = element.parent;
    while (parent) {
      if (parent.tagName === tagName) {
        return parent;
      }
      parent = parent.parent;
    }
    return null;
  }
}

