ADD_LIBRARY(anti_tamper OBJECT
    AntiTamper.cpp
)

if(CODE_COVERAGE AND UNIX)
	  target_compile_options(anti_tamper PUBLIC
	    -O0
	    -g
	    --coverage
	  )
endif(CODE_COVERAGE AND UNIX)
