/*
 * virtualization.cpp
 *
 *  Created on: Dec 15, 2019
 *      Author: GC
 */
#include <windows.h>
#include <sys/stat.h>
#include <fstream>
#include <iostream>
#include <stdio.h>
#include <string>

#include "../../base/base.h"

#include "../cpu_info.hpp"
#include "../execution_environment.hpp"

namespace license {
namespace os {
using namespace std;

ExecutionEnvironment::ExecutionEnvironment() : m_container_type(CONTAINER_TYPE::NONE) {}

}  // namespace os
}  // namespace license
