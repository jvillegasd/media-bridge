import argparse
from downloader import Downloader

def main():
    parser = argparse.ArgumentParser(description='Download videos using youtube-dl.')
    parser.add_argument('url', type=str, help='The URL of the video to download.')
    parser.add_argument('-o', '--output', type=str, help='The output file name (optional).')

    args = parser.parse_args()

    downloader = Downloader()
    downloader.download_video(args.url, args.output)

if __name__ == '__main__':
    main()