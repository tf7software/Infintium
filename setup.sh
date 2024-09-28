#!/bin/bash



# Install Python 3 and pip if they are not installed
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is not installed. Installing Python 3..."
    sudo apt install -y python3 python3-pip
else
    echo "Python 3 is already installed."
fi

# Install necessary Python libraries
echo "Installing required Python libraries..."
pip3 install beautifulsoup4 requests lxml

echo "Setup complete!"
