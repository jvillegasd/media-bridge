from setuptools import setup, find_packages

setup(
    name='media-bridge',
    version='0.1.0',
    packages=find_packages(where='src'),
    package_dir={'': 'src'},
    install_requires=[
        'youtube-dl',
    ],
    entry_points={
        'console_scripts': [
            'media-bridge=cli:main',
        ],
    },
    author='jvillegasd',
    author_email='johnnyvillegaslrs@gmail.com',
    description='A command-line interface for downloading videos using youtube-dl.',
    long_description=open('README.md').read(),
    long_description_content_type='text/markdown',
    url='https://github.com/jvillegasd/media-bridge',
    classifiers=[
        'Programming Language :: Python :: 3.12',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
    ],
    python_requires='>=3.12',
)