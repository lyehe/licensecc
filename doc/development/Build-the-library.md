# Build - Linux

## Install prerequisites
Below the prerequisites for compiling `licensecc`. For developing it we use Eclipse. 
Recent CDT works smoothly with CMake. Remember to install the Ninja package as build system and Cmake Gui for a good eclipse integration.
 
### Ubuntu
Supported Ubuntu distributions are 20.04 (Focal Fossa), 18.04 (Bionic Beaver) and 16.04 (Xenial). 
It should be possible to build on any recent Debian-derivate distribution.

Install prerequisites:

```console
sudo apt-get install cmake valgrind libssl-dev zlib1g-dev libboost-test-dev libboost-filesystem-dev \
     libboost-iostreams-dev libboost-program-options-dev libboost-system-dev libboost-thread-dev \
     libboost-date-time-dev build-essential
```

For development with eclipse:

```console
sudo apt-get install cmake-gui ninja-build
```

### CentOS 7

CentOS 7 ships with gcc 4.8 that isn't compiling for a bug on regular expression. It's necessary to update to gcc 4.9 or later.
Install prerequisites:

```console
yum -y update && yum -y install install centos-release-scl
yum -y install wget boost boost-devel boost-static openssl openssl-devel openssl-static 
yum -y install glibc-static devtoolset-7-toolchain devtoolset-7-gcc devtoolset-7-gcc-c++ devtoolset-7-valgrind-devel

export CC=/opt/rh/devtoolset-7/root/usr/bin/gcc
export CXX=/opt/rh/devtoolset-7/root/usr/bin/g++
```

Centos 7 ships with CMake 2.8.11 that's not supported. You need to compile and install a newer (>3.6) version of CMake.

```console
wget https://cmake.org/files/v3.11/cmake-3.11.0.tar.gz 
tar zxvf cmake-3.11.0.tar.gz 
cd cmake-3.11.0
./bootstrap 
make 
sudo make install
cmake --version #(check it's 3.11.0) 
```

If you don't want to install all these prerequisites in your machine you can also build the library in a docker container. 
Check for the corresponding Centos 7 section in the `.travis.yml` file at the base of the project.

### CentOS 8
Install prerequisites:

```console
yum -y update && yum -y groupinstall 'Development Tools' 
yum -y install wget cmake boost boost-devel openssl-devel zlib-devel  
dnf -y --enablerepo=PowerTools install boost-static 
```

CentOS 8 doesn't ship with a static version of openssl. It is necessary to compile it from sources.

```console
wget https://github.com/openssl/openssl/archive/OpenSSL_1_1_1d.tar.gz 
tar xzf OpenSSL_1_1_1d.tar.gz && cd openssl-OpenSSL_1_1_1d 
./config && make -j 8
sudo make install 
```

### Other linux
Licensecc should compile on any recent (2020) linux distribution. Being CentOS 7 the older distribution we keep compatibilty with. 

Minimum prerequisites
*   gcc => 4.9, cmake => 3.6
*   zlib, openssl => 1.0.2 
*   Boost => 1.57 (If you want to compile your own boost version remember to use the flag `runtime-link=static`)

Optional prerequisites:
*   Doxygen, Sphynx for documentation

## Download and compile

### Download:
This project has a submodule (the license generator). Remember to add the option `--recursive` to clone it.

```console
git clone --recursive https://github.com/open-license-manager/licensecc.git
```

### Configure:

Use PowerShell 7 to inspect or initialize the pinned generator checkout. Configure/build commands themselves never run source-control operations.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug
```

### Manual compile and test:

```console
cmake -S . -B build/dev-debug -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test -DCMAKE_INSTALL_PREFIX=build/dev-debug/install
cmake --build build/dev-debug
ctest --test-dir build/dev-debug --output-on-failure
```

```console
make test
ctest -T memcheck
```

### cmake useful flags

|Definition name           |Description|
|--------------------------|-----------|
|LCC_PROJECT_NAME=<str>  | This correspond to the name of the project you're generating licenses for. The flag is optional, if you don't specify it the build system will create a project named `DEFAULT` for you |
|LCC_LOCATION=<path>     | Explicit lccgen executable, installation prefix, or CMake package location. When set, no bundled or PATH fallback is used. A standalone executable is supported for production builds with `BUILD_TESTING=OFF`; the default test build requires the embedded checkout or a compatible generator development package with test support. |
|BUILD_TESTING=ON/OFF    | Builds the C++ test tree (default `ON` when Boost is available). A raw external `lccgen` executable has no private signing-test library, so configure with `-DBUILD_TESTING=OFF` for that production-only mode. |
|LCC_PROJECTS_BASE_DIR=<path> | Generated project base. It must be external to the source checkout or under the active build directory; stable external key directories are supported. |
|CMAKE_BUILD_TYPE=Release| generate a release version of the library (should be used as default)|
|CMAKE_INSTALL_PREFIX    | folder where to install compiled libraries and headers. (default: /usr/local)               |
|BOOST_ROOT              | Folder where boost was installed (optional: if you installed boost using system package manager this should not be necessary) |
|OPENSSL_ROOT            | Folder where OpenSSL was installed (optional: if you installed openssl as system package this should not be necessary) |

## Cross compile on Linux for Windows
Tested on host: Ubuntu 18.04

### Prerequisites

```console
sudo apt-get install cmake valgrind binutils-mingw-w64 mingw-w64 mingw-w64-tools \ 
	mingw-w64-x86-64-dev libz-mingw-w64-dev wine-stable wine-binfmt p7zip-full
```

Download and compile boost:

```console
export CUR_PATH=$(pwd)
wget -c https://dl.bintray.com/boostorg/release/1.71.0/source/boost_1_71_0.tar.bz2
tar xjf boost_1_71_0.tar.bz2
rm boost_1_71_0.tar.bz2
cd boost_1_71_0
sudo ln -s /usr/bin/x86_64-w64-mingw32-g++ /usr/local/bin/g++-mingw 
./bootstrap.sh
./b2 toolset=gcc-mingw target-os=windows address-model=64 --with-date_time --with-test --with-filesystem --with-program_options --with-regex --with-serialization --with-system runtime-link=static --prefix=./dist release install
```

Install OpenSSL:

```console
wget --no-check-certificate https://bintray.com/vszakats/generic/download_file?file_path=openssl-1.0.2h-win64-mingw.7z -O openssl.7z
7z x openssl.7z
rm openssl.7z
```
Configure and compile:
 
```
cmake -DCMAKE_TOOLCHAIN_FILE=../modules/toolchain-ubuntu-mingw64.cmake -DOPENSSL_ROOT_DIR=$CUR_PATH/openssl-OpenSSL_1_1_1d/dist -DCMAKE_FIND_DEBUG_MODE=ON -DOPENSSL_USE_STATIC_LIBS=ON -DBOOST_ROOT=$CUR_PATH/boost_1_71_0/dist  ..

```

###Build documentation

Install the pinned documentation dependencies with `uv`:

```
python3 -m venv .venv

. .venv/bin/activate
pip install wheel
uv pip sync doc/requirements.txt

```

The strict documentation command writes only ignored output directories and
never relies on a root-level Python requirements file.

Build the docs (with Doxygen and Sphinx warnings treated as errors):

```
npm run check:docs
```
